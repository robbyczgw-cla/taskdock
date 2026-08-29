import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupDir, tempDir } from "./helpers.ts";

const repoRoot = join(import.meta.dirname, "..");

type CmdResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function run(command: string, args: string[], cwd = repoRoot): Promise<CmdResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => {
      stdout += data;
    });
    proc.stderr.on("data", (data) => {
      stderr += data;
    });
    proc.once("error", reject);
    proc.once("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

test("npm pack installs a working taskdock binary", {
  timeout: 120_000,
  skip: process.env.SKIP_PACK === "1",
}, async () => {
  const packed = await run("npm", ["pack"]);
  assert.equal(packed.code, 0, packed.stderr || packed.stdout);

  const tarballName = packed.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  assert.ok(tarballName?.endsWith(".tgz"), `expected tarball name, got: ${packed.stdout}`);
  const tarball = join(repoRoot, tarballName);

  const prefix = tempDir("taskdock-pack-");
  try {
    const installed = await run("npm", ["install", "--prefix", prefix, tarball]);
    assert.equal(installed.code, 0, installed.stderr || installed.stdout);

    const help = await run(
      join(prefix, "node_modules", ".bin", "taskdock"),
      ["--help"],
      prefix,
    );
    assert.equal(help.code, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage/);
  } finally {
    if (existsSync(tarball)) unlinkSync(tarball);
    cleanupDir(prefix);
  }
});
