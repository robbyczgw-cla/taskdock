//! HTTP wrapper around the official rmcp Tasks example (`TaskDemo`).
//!
//! Tasks semantics (`TaskManager`, `tasks/get`, `CreateTaskResult`) come from
//! crate `rmcp` 3.1 (modelcontextprotocol/rust-sdk). This file only:
//! - copies the official TaskDemo handler (examples/servers/src/common/task_demo.rs)
//! - serves it over Streamable HTTP like examples/servers/src/counter_streamhttp.rs
//! - clones one TaskDemo so TaskManager state is shared across HTTP requests
//!
//! See: https://github.com/modelcontextprotocol/rust-sdk

use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars,
    service::{RequestContext, RoleServer},
    task_manager::{TaskExit, TaskManager, TaskOptions},
    tool, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService,
        session::local::LocalSessionManager,
    },
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

const BIND_ADDRESS: &str = "0.0.0.0:8000";

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SumArgs {
    pub a: i32,
    pub b: i32,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct EchoArgs {
    pub message: String,
}

#[derive(Clone)]
pub struct TaskDemo {
    tool_router: ToolRouter<TaskDemo>,
    tasks: TaskManager,
}

#[tool_router]
impl TaskDemo {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
            tasks: TaskManager::new(),
        }
    }

    #[tool(description = "Sum two numbers after a 2-second delay")]
    async fn slow_sum(
        &self,
        Parameters(SumArgs { a, b }): Parameters<SumArgs>,
    ) -> Result<CallToolResult, McpError> {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        Ok(CallToolResult::success(vec![ContentBlock::text(
            (a + b).to_string(),
        )]))
    }

    #[tool(description = "Echo a message back immediately")]
    async fn quick_echo(
        &self,
        Parameters(EchoArgs { message }): Parameters<EchoArgs>,
    ) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![ContentBlock::text(message)]))
    }
}

impl ServerHandler for TaskDemo {
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let client_supports_tasks = context
            .client_capabilities()
            .is_some_and(|caps| caps.supports_tasks());

        if request.name == "slow_sum" && client_supports_tasks {
            let params: SumArgs = serde_json::from_value(serde_json::Value::Object(
                request.arguments.clone().unwrap_or_default(),
            ))
            .map_err(|e| McpError::invalid_params(e.to_string(), None))?;
            let task = self.tasks.spawn(TaskOptions::default(), move |ctx| {
                Box::pin(async move {
                    tokio::select! {
                        _ = ctx.cancelled() => {
                            Err(TaskExit::Cancelled)
                        }
                        _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {
                            Ok(CallToolResult::success(vec![ContentBlock::text(
                                (params.a + params.b).to_string(),
                            )]))
                        }
                    }
                })
            });
            return Ok(CallToolResponse::Task(CreateTaskResult::new(task)));
        }

        let tcc = rmcp::handler::server::tool::ToolCallContext::new(self, request, context);
        self.tool_router.call(tcc).await
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(self.tool_router.list_all()))
    }

    async fn get_task(
        &self,
        request: GetTaskParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetTaskResult, McpError> {
        Ok(GetTaskResult::new(self.tasks.get_task(&request.task_id)?))
    }

    async fn update_task(
        &self,
        request: UpdateTaskParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<(), McpError> {
        self.tasks
            .update_task(&request.task_id, request.input_responses)
    }

    async fn cancel_task(
        &self,
        request: CancelTaskParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<(), McpError> {
        self.tasks.cancel_task(&request.task_id)
    }

    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tasks()
                .build(),
        )
        .with_instructions(
            "Official rmcp TaskDemo over Streamable HTTP. slow_sum returns a task."
                .to_string(),
        )
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".to_string().into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let ct = tokio_util::sync::CancellationToken::new();
    let demo = TaskDemo::new();
    let mut config = StreamableHttpServerConfig::default().with_cancellation_token(ct.child_token());
    config.json_response = true;
    config.allowed_hosts = vec![
        "127.0.0.1".into(),
        "localhost".into(),
        "0.0.0.0".into(),
        "127.0.0.1:8000".into(),
        "localhost:8000".into(),
    ];

    let service = StreamableHttpService::new(
        {
            let demo = demo.clone();
            move || Ok(demo.clone())
        },
        LocalSessionManager::default().into(),
        config,
    );

    let router = axum::Router::new()
        .route("/health", axum::routing::get(|| async { "ok" }))
        .nest_service("/mcp", service);

    tracing::info!("rmcp TaskDemo listening on http://{BIND_ADDRESS}/mcp");
    let tcp_listener = tokio::net::TcpListener::bind(BIND_ADDRESS).await?;
    axum::serve(tcp_listener, router)
        .with_graceful_shutdown(async move {
            tokio::signal::ctrl_c().await.ok();
            ct.cancel();
        })
        .await?;
    Ok(())
}
