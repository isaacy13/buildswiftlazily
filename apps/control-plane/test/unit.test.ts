import test from "node:test";
import assert from "node:assert/strict";
import { detectIosProjects } from "../src/github.js";
import {
  assertSafeAgentId,
  assertSafeBundleId,
  assertSafeBundleVersion,
  assertSafeConfiguration,
  assertSafeDeployMode,
  assertSafePlatform,
  assertSafeRef,
  assertSafeRelPath,
  assertSafeRepo,
  assertSafeScheme,
  assertSafeTitle,
} from "../src/config.js";
import { scoreGuideAiRelevance } from "../src/cursor.js";
import {
  buildInstallHtml,
  buildItmsUrl,
  buildManifestPlist,
} from "../src/ota.js";
import { apiTokenOk, DeployGate, publicError, redact } from "../src/security.js";
import { JobStore } from "../src/jobs.js";

test("detectXcodeProjects finds workspace, skips Pods, hints watchOS", () => {
  const paths = [
    "GuideAI.xcodeproj/project.pbxproj",
    "GuideAI.xcworkspace/contents.xcworkspacedata",
    "Pods/Some.xcodeproj/project.pbxproj",
    "Features/Foo/Foo.xcodeproj/project.pbxproj",
    "WatchApp/MyWatch Watch App.xcodeproj/project.pbxproj",
  ];
  const found = detectIosProjects(paths, 4);
  assert.ok(found.some((f) => f.name === "GuideAI" && f.kind === "workspace"));
  assert.ok(!found.some((f) => f.projectPath.includes("Pods")));
  assert.ok(found.some((f) => f.projectPath === "Features/Foo"));
  const watch = found.find((f) => /watch/i.test(f.name));
  assert.ok(watch);
  assert.ok(watch.platforms.includes("watchos"));
});

test("assertSafePlatform accepts ios and watchos", () => {
  assert.equal(assertSafePlatform("ios"), "ios");
  assert.equal(assertSafePlatform("watchOS"), "watchos");
  assert.throws(() => assertSafePlatform("tvos"));
});

test("assertSafeRepo accepts owner/name only", () => {
  assert.equal(assertSafeRepo("isaacy13/GuideAI"), "isaacy13/GuideAI");
  assert.throws(() => assertSafeRepo("../etc/passwd"));
  assert.throws(() => assertSafeRepo("https://github.com/a/b"));
});

test("assertSafeRef rejects traversal and metacharacters", () => {
  assert.equal(assertSafeRef("feature/foo"), "feature/foo");
  assert.throws(() => assertSafeRef("main;rm -rf /"));
  assert.throws(() => assertSafeRef("foo/../bar"));
});

test("assertSafeRelPath rejects absolute and ..", () => {
  assert.equal(assertSafeRelPath("ios/App"), "ios/App");
  assert.throws(() => assertSafeRelPath("../secret"));
  assert.throws(() => assertSafeRelPath("/etc"));
});

test("assertSafeScheme / configuration / title / mode", () => {
  assert.equal(assertSafeScheme("GuideAI"), "GuideAI");
  assert.throws(() => assertSafeScheme("x;y"));
  assert.equal(assertSafeConfiguration("Release"), "Release");
  assert.throws(() => assertSafeConfiguration("Release`id`"));
  assert.equal(assertSafeTitle("My App"), "My App");
  assert.throws(() => assertSafeTitle('bad"title'));
  assert.throws(() => assertSafeTitle("bad\ntitle"));
  assert.equal(assertSafeDeployMode("ota"), "ota");
  assert.throws(() => assertSafeDeployMode("wipe"));
  assert.equal(assertSafeAgentId("bc_abc-123"), "bc_abc-123");
  assert.throws(() => assertSafeAgentId("../x"));
  assert.equal(assertSafeBundleId("com.example.GuideAI"), "com.example.GuideAI");
  assert.throws(() => assertSafeBundleId("com;rm"));
  assert.equal(assertSafeBundleVersion("1.2.3"), "1.2.3");
  assert.throws(() => assertSafeBundleVersion("1\n2"));
});

test("apiTokenOk uses constant-time compare", () => {
  assert.equal(apiTokenOk("", null), true);
  assert.equal(apiTokenOk("secret-token-value", null), false);
  assert.equal(apiTokenOk("secret-token-value", "secret-token-value"), true);
  assert.equal(apiTokenOk("secret-token-value", "other-token-value"), false);
});

test("publicError redacts and avoids dumping objects", () => {
  assert.match(publicError(new Error("boom ghp_abcdefghijklmnopqrstuvwxyz12")), /REDACTED/);
  assert.equal(publicError({ nope: true }), "request failed");
});

test("scoreGuideAiRelevance prefers GuideAI agents", () => {
  const a = scoreGuideAiRelevance(
    {
      id: "1",
      name: "GuideAI polish",
      branches: [{ repoUrl: "github.com/x/GuideAI", branch: "feat" }],
      updatedAt: new Date().toISOString(),
    },
    "x/GuideAI",
  );
  const b = scoreGuideAiRelevance(
    { id: "2", name: "unrelated", updatedAt: "2020-01-01T00:00:00Z" },
    "x/GuideAI",
  );
  assert.ok(a > b);
});

test("OTA manifest + itms URL", () => {
  const manifest = buildManifestPlist({
    baseUrl: "https://mac.tailnet.ts.net/ota/abc",
    title: "GuideAI",
    bundleId: "com.example.GuideAI",
    bundleVersion: "9",
  });
  assert.match(manifest, /com\.example\.GuideAI/);
  assert.match(
    manifest,
    /https:\/\/mac\.tailnet\.ts\.net\/ota\/abc\/App\.ipa/,
  );
  const itms = buildItmsUrl(
    "https://mac.tailnet.ts.net/ota/abc/manifest.plist",
  );
  assert.ok(itms.startsWith("itms-services://?action=download-manifest&url="));
  const html = buildInstallHtml({
    baseUrl: "https://mac.tailnet.ts.net/ota/abc",
    title: "GuideAI",
    bundleId: "com.example.GuideAI",
    bundleVersion: "9",
  });
  assert.match(html, /Install on this iPhone/);
  assert.match(html, /itms-services/);
});

test("redact strips tokens", () => {
  const s = redact(
    "Authorization Bearer ghp_abcdefghijklmnopqrstuvwxyz12 hello",
    ["supersecretvalue12"],
  );
  assert.equal(s.includes("ghp_"), false);
  assert.match(s, /REDACTED/);
  assert.equal(
    redact("x supersecretvalue12 y", ["supersecretvalue12"]),
    "x [REDACTED] y",
  );
  assert.match(redact("Basic YWJjZGVmZ2hpams="), /REDACTED/);
});

test("redact strips BSL_KEYCHAIN_PASSWORD including short values", () => {
  const prev = process.env.BSL_KEYCHAIN_PASSWORD;
  process.env.BSL_KEYCHAIN_PASSWORD = "hunter2";
  try {
    assert.equal(
      redact("unlock failed for hunter2 in keychain"),
      "unlock failed for [REDACTED] in keychain",
    );
  } finally {
    if (prev === undefined) delete process.env.BSL_KEYCHAIN_PASSWORD;
    else process.env.BSL_KEYCHAIN_PASSWORD = prev;
  }
});

test("childEnvForScript only passes keychain password to build-ios.sh", async () => {
  const { childEnvForScript } = await import("../src/localDeploy.js");
  const base = {
    PATH: "/usr/bin",
    BSL_KEYCHAIN_PASSWORD: "sekrit-pass",
    OTHER: "1",
  };
  const forBuild = childEnvForScript("build-ios.sh", base);
  assert.equal(forBuild.BSL_KEYCHAIN_PASSWORD, "sekrit-pass");
  const forInstall = childEnvForScript("install-direct.sh", base);
  assert.equal(forInstall.BSL_KEYCHAIN_PASSWORD, undefined);
  assert.equal(forInstall.OTHER, "1");
});

test("DeployGate enforces single flight and cooldown", () => {
  const gate = new DeployGate(60_000);
  assert.equal(gate.tryAcquire().ok, true);
  gate.bindJob("job-1");
  const blocked = gate.tryAcquire();
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.match(blocked.reason, /already in progress/i);
    assert.equal(blocked.jobId, "job-1");
  }
  gate.release();
  const again = gate.tryAcquire();
  assert.equal(again.ok, false);
  if (!again.ok) assert.ok(again.retryAfterSec > 0);
});

test("JobStore.findLive returns newest queued/running job", () => {
  const jobs = new JobStore();
  jobs.create({
    engine: "local",
    repository: "a/b",
    ref: "main",
    scheme: "App",
    deployMode: "ota",
    status: "succeeded",
  });
  assert.equal(jobs.findLive(), undefined);
  const live = jobs.create({
    engine: "local",
    repository: "a/b",
    ref: "main",
    scheme: "App",
    deployMode: "ota",
    status: "running",
  });
  assert.equal(jobs.findLive()?.id, live.id);
});
