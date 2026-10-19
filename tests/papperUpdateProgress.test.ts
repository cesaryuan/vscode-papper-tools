import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type * as vscode from "vscode";
import type * as BuildUtils from "../src/papperBuildUtils";
import type { PapperUpdateChecker } from "../src/papperUpdateChecker";
import { SourceModuleFixture } from "./helpers/sourceModule";

type Child = EventEmitter & { stdout: PassThrough; stderr: PassThrough };

function processFixture(run: (child: Child, args: string[]) => void, replacements: Record<string, unknown> = {}) {
  const messages: string[] = [];
  const logs: string[] = [];
  const calls: string[][] = [];
  const progress = { report: ({ message }: { message?: string }) => { messages.push(message!); } };
  const output = {
    append: (text: string) => { logs.push(text); },
    appendLine: (text: string) => { logs.push(`${text}\n`); },
  } as vscode.OutputChannel;
  const utils = new SourceModuleFixture({
    vscode: {},
    child_process: {
      spawn: (_command: string, args: string[]) => {
        calls.push(args);
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
        queueMicrotask(() => run(child, args));
        return child;
      },
    },
    ...replacements,
  }).load<typeof BuildUtils>("src/papperBuildUtils.ts");
  return { utils, messages, logs, calls, progress, output };
}

test("streams stdout and stderr into progress while retaining captured output and complete logs", async () => {
  const fixture = processFixture((child) => {
    child.stdout.write("Resolved 3 packages\n");
    child.stderr.write("Downloading papper\n");
    child.stdout.write("Installed papper\n");
    child.emit("close", 0);
  });
  const result = await fixture.utils.runProcess("uv", [], { ...fixture, captureStdout: true });
  assert.equal(result, "Resolved 3 packages\nInstalled papper");
  assert.deepEqual(fixture.messages, ["Resolved 3 packages", "Downloading papper", "Installed papper"]);
  assert.equal(fixture.logs.join(""), "Resolved 3 packages\nDownloading papper\nInstalled papper\n");
});

test("keeps partial lines separate per stream and handles ANSI colors, carriage returns and blank lines", async () => {
  const fixture = processFixture((child) => {
    child.stdout.write("Resol");
    child.stderr.write("\u001b[32mDownload");
    child.stdout.write("ved 3 packages\r\n");
    child.stderr.write("ing papper\u001b[0m\rDownloaded papper\r\n\n");
    child.emit("close", 0);
  });
  await fixture.utils.runProcess("uv", [], fixture);
  assert.deepEqual(fixture.messages, ["Resol", "Download", "Resolved 3 packages", "Downloaded papper"]);
});

test("decodes split UTF-8 output without corrupting notification messages or logs", async () => {
  const text = "正在更新 Papper\n";
  const fixture = processFixture((child) => {
    const bytes = Buffer.from(text);
    child.stderr.write(bytes.subarray(0, 2));
    child.stderr.write(bytes.subarray(2));
    child.emit("close", 0);
  });
  await fixture.utils.runProcess("uv", [], fixture);
  assert.deepEqual(fixture.messages, [text.trim()]);
  assert.equal(fixture.logs.join(""), text);
});

test("bounds long notification lines and keeps the unabridged output log", async () => {
  const text = "x".repeat(20_000);
  const fixture = processFixture((child) => {
    child.stderr.write(text);
    child.emit("close", 0);
  });
  await fixture.utils.runProcess("uv", [], fixture);
  assert.equal(fixture.messages[0].length, 500);
  assert.equal(fixture.logs.join(""), text);
});

test("still rejects failed commands with stderr after reporting their output", async () => {
  const fixture = processFixture((child) => {
    child.stderr.write("Network unavailable\n");
    child.emit("close", 1);
  });
  await assert.rejects(fixture.utils.runProcess("uv", [], fixture), /exited with code 1: Network unavailable/);
  assert.deepEqual(fixture.messages, ["Network unavailable"]);
});

test("preserves process execution without a progress reporter", async () => {
  const fixture = processFixture((child) => {
    child.stdout.write("tool-bin\n");
    child.emit("close", 0);
  });
  assert.equal(await fixture.utils.runProcess("uv", [], { captureStdout: true }), "tool-bin");
  assert.deepEqual(fixture.messages, []);
});

function maintenanceFixture(useMirror = false) {
  const bin = path.join(path.parse(process.cwd()).root, "papper-progress-fixture-bin");
  let attempts = 0;
  return processFixture((child, args) => {
    if (args.includes("dir")) {
      child.stdout.write(`${bin}\n`);
    } else {
      attempts++;
      child.stderr.write(attempts === 1 && useMirror ? "Mirror unavailable\n" : "Updated papper\n");
    }
    child.emit("close", useMirror && args.includes("--default-index") ? 1 : 0);
  }, {
    "fs/promises": {
      stat: async (filename: string) => {
        const name = path.basename(filename).toLowerCase();
        const uv = name === (process.platform === "win32" ? "uv.exe" : "uv");
        const papper = path.dirname(filename) === bin && name === (process.platform === "win32" ? "papper.exe" : "papper");
        if (!uv && !papper) throw new Error("ENOENT");
        return { isFile: () => true, mode: 0o755 };
      },
    },
    "src/papperToolPolicy.ts": {
      CHINESE_PYPI_MIRROR: "https://mirror.example/simple",
      shouldUseChinesePypiMirror: () => useMirror,
    },
  });
}

test("manual installation/update forwards command output to notification progress", async () => {
  const fixture = maintenanceFixture();
  const executable = await fixture.utils.installOrUpdatePapper(fixture.output, fixture.progress);
  assert.match(executable, /papper(?:\.exe)?$/i);
  assert.deepEqual(fixture.messages, ["Updated papper"]);
  assert.ok(fixture.calls.some((args) => args.join(" ") === "tool install papper --upgrade"));
  assert.ok(fixture.logs.join("").includes("Updated papper"));
});

test("mirror fallback continues reporting progress from the retried installation", async () => {
  const fixture = maintenanceFixture(true);
  await fixture.utils.installOrUpdatePapper(fixture.output, fixture.progress);
  assert.deepEqual(fixture.messages, ["Mirror unavailable", "Updated papper"]);
  assert.ok(fixture.calls.some((args) => args.includes("--default-index")));
  assert.ok(fixture.calls.some((args) => args.join(" ") === "tool install papper --upgrade"));
});

test("automatic upgrade forwards command output to notification progress and the output channel", async () => {
  const fixture = maintenanceFixture();
  await fixture.utils.upgradePapper(fixture.output, fixture.progress);
  assert.deepEqual(fixture.messages, ["Updated papper"]);
  assert.deepEqual(fixture.calls, [["tool", "upgrade", "papper"]]);
  assert.ok(fixture.logs.join("").includes("Updated papper"));
});

test("confirmed automatic updates pass the notification reporter and shared output channel to the upgrade", async () => {
  const progress = { report: () => {} };
  const output = {} as vscode.OutputChannel;
  const notifications: string[] = [];
  let upgraded = false;
  const { PapperUpdateChecker: Checker } = new SourceModuleFixture({
    vscode: {
      ProgressLocation: { Notification: 15 },
      window: {
        showInformationMessage: async (message: string, ...actions: string[]) => {
          notifications.push(message);
          return actions[0];
        },
        withProgress: async (options: { location: number; title: string }, task: (reporter: typeof progress) => Promise<void>) => {
          assert.equal(options.location, 15);
          assert.equal(options.title, "Updating Papper");
          await task(progress);
        },
      },
    },
    "src/papperBuildUtils.ts": {
      checkForPapperUpdate: async () => ({ summary: "papper v1 -> v2" }),
      upgradePapper: async (channel: vscode.OutputChannel, reporter: typeof progress) => {
        assert.equal(channel, output);
        assert.equal(reporter, progress);
        upgraded = true;
      },
    },
  }).load<{ PapperUpdateChecker: typeof PapperUpdateChecker }>("src/papperUpdateChecker.ts");
  const checker = new Checker({ get: () => 0, update: async () => {} } as unknown as vscode.Memento, output);
  await (checker as unknown as { check: () => Promise<void> }).check();
  assert.equal(upgraded, true);
  assert.equal(notifications.at(-1), "Papper has been updated.");
});
