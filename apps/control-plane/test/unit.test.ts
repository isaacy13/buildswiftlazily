import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
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
import { scoreGuideAiRelevance, isArchivedAgentFields } from "../src/cursor.js";
import {
  buildInstallHtml,
  buildItmsUrl,
  buildManifestPlist,
} from "../src/ota.js";
import { apiTokenOk, DeployGate, publicError, redact, stampLogLine } from "../src/security.js";
import { JobStore } from "../src/jobs.js";
import {
  filterAndRank,
  looksLikeRef,
  matchesQuery,
  rankMatch,
} from "../src/search.js";
import {
  explainDeployFailure,
  failedScriptName,
  lastBuildErrors,
  sweepJobArtifacts,
} from "../src/localDeploy.js";

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

test("isArchivedAgentFields detects archived agents", () => {
  assert.equal(isArchivedAgentFields({ isArchived: true, status: "IDLE" }), true);
  assert.equal(isArchivedAgentFields({ archived: true }), true);
  assert.equal(isArchivedAgentFields({ status: "ARCHIVED" }), true);
  assert.equal(isArchivedAgentFields({ status: "RUNNING", isArchived: false }), false);
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

test("DeployGate self-heals stuck inflight with no live job", () => {
  const gate = new DeployGate(0);
  assert.equal(gate.tryAcquire().ok, true);
  // Simulate acquire without bindJob / lost live job
  const healed = gate.tryAcquire(() => undefined);
  assert.equal(healed.ok, true);
  gate.bindJob("job-2");
  const blocked = gate.tryAcquire(() => "job-2");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.jobId, "job-2");
});

test("DeployGate recovers jobId from findLive when bind was missed", () => {
  const gate = new DeployGate(0);
  assert.equal(gate.tryAcquire().ok, true);
  // inflight but no bindJob — look up live id
  const blocked = gate.tryAcquire(() => "recovered-job");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.jobId, "recovered-job");
    assert.match(blocked.reason, /already in progress/i);
  }
  assert.equal(gate.getInflightJobId(), "recovered-job");
});

test("matchesQuery finds substring, tokens, and compact hyphen-insensitive names", () => {
  const branch = "cursor/search-functionality-4b3d";
  assert.equal(matchesQuery(branch, ""), true);
  assert.equal(matchesQuery(branch, "search"), true);
  assert.equal(matchesQuery(branch, "SEARCH FUNC"), true);
  assert.equal(matchesQuery(branch, "searchfunctionality"), true);
  assert.equal(matchesQuery(branch, "cursor/search"), true);
  assert.equal(matchesQuery(branch, "nope"), false);
  assert.equal(matchesQuery("GuideAI", "guide"), true);
});

test("rankMatch prefers exact then prefix then path-segment hits", () => {
  assert.ok(rankMatch("main", "main") < rankMatch("mainline", "main"));
  assert.ok(rankMatch("cursor/search-ui", "search") < rankMatch("research-notes", "search"));
});

test("filterAndRank orders and limits branch hits", () => {
  const branches = [
    { name: "main" },
    { name: "cursor/search-functionality-4b3d" },
    { name: "cursor/other-a490" },
    { name: "research-notes" },
  ];
  const { matches, total } = filterAndRank(
    branches,
    "search",
    (b) => b.name,
    10,
  );
  assert.equal(total, 2);
  assert.equal(matches[0].name, "cursor/search-functionality-4b3d");
  assert.ok(matches.some((b) => b.name === "research-notes"));
  assert.ok(!matches.some((b) => b.name === "main"));
  assert.ok(!matches.some((b) => b.name === "cursor/other-a490"));
});

test("looksLikeRef accepts git-safe names and rejects junk", () => {
  assert.equal(looksLikeRef("cursor/search-functionality-4b3d"), true);
  assert.equal(looksLikeRef("feature/foo"), true);
  assert.equal(looksLikeRef("foo/../bar"), false);
  assert.equal(looksLikeRef("main;rm"), false);
  assert.equal(looksLikeRef(""), false);
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
  jobs.patch(live.id, { status: "cancelled" });
  assert.equal(jobs.findLive(), undefined);
});

test("stampLogLine prefixes local time and skips existing timestamps", () => {
  const d = new Date(2026, 7, 14, 3, 54, 25);
  assert.equal(stampLogLine("FAILED after 9m", d), "2026-08-14 03:54:25 FAILED after 9m");
  assert.equal(
    stampLogLine("2026-08-13 21:27:31.545 already from xcodebuild", d),
    "2026-08-13 21:27:31.545 already from xcodebuild",
  );
});

test("appendLog stamps job lines", () => {
  const jobs = new JobStore();
  const job = jobs.create({
    engine: "local",
    repository: "a/b",
    ref: "main",
    scheme: "App",
    deployMode: "ota",
    status: "running",
  });
  jobs.appendLog(job.id, "Deploy started");
  assert.match(jobs.get(job.id).logs[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} Deploy started$/);
  jobs.appendLog(job.id, "2026-08-13 21:27:31.545 xcodebuild");
  assert.equal(jobs.get(job.id).logs[1], "2026-08-13 21:27:31.545 xcodebuild");
});

test("failedScriptName reads the helper that exited", () => {
  assert.equal(failedScriptName("build-ios.sh exited 2 after 9m 41s"), "build-ios.sh");
  assert.equal(failedScriptName("upload-testflight.sh exited 1 after 2m"), "upload-testflight.sh");
  assert.equal(failedScriptName("boom"), "");
});

test("lastBuildErrors keeps xcodebuild error: lines only", () => {
  const blob = [
    "Running: xcodebuild --mode testflight",
    "CFBundleVersion=42",
    "error: Provisioning profile doesn't include signing certificate",
    "** ARCHIVE FAILED **",
  ].join("\n");
  const got = lastBuildErrors(blob);
  assert.match(got, /Provisioning profile/);
  assert.match(got, /ARCHIVE FAILED/);
  assert.doesNotMatch(got, /CFBundleVersion/);
});

test("explainDeployFailure does not treat archive --mode testflight as an ASC upload failure", () => {
  const raw = "build-ios.sh exited 2 after 9m 41s";
  const blob = `${raw}\n$ build-ios.sh --mode testflight --scheme GuideAI\nCFBundleVersion=7 (must be unique per upload)\nerror: No Account for Team\n** ARCHIVE FAILED **`;
  const msg = explainDeployFailure(raw, blob);
  assert.match(msg, /Archive or IPA export failed \(before TestFlight upload\)/);
  assert.match(msg, /No Account for Team/);
  assert.doesNotMatch(msg, /TestFlight\/ASC upload issue/);
  assert.doesNotMatch(msg, /AuthKey_/);
});

test("explainDeployFailure treats bash unbound variable as a tooling bug", () => {
  const raw = "upload-testflight.sh exited 1 after 0s";
  const blob = `${raw}\nscripts/upload-testflight.sh: line 215: BUNDLE_ID…: unbound variable`;
  const msg = explainDeployFailure(raw, blob);
  assert.match(msg, /unset variable/);
  assert.match(msg, /tooling bug/);
  assert.match(msg, /unbound variable/);
  assert.doesNotMatch(msg, /BSL_ASC_KEY_ID/);
  assert.doesNotMatch(msg, /AuthKey_/);
});

test("explainDeployFailure still explains real altool failures", () => {
  const raw = "upload-testflight.sh exited 1 after 3m";
  const blob = `${raw}\nUnable to authenticate with App Store Connect\nITMS-90018`;
  const msg = explainDeployFailure(raw, blob);
  assert.match(msg, /TestFlight\/ASC upload issue/);
});

test("explainDeployFailure explains dangling PlugIns appex aliases", () => {
  const raw = "build-ios.sh exited 2 after 7m 58s";
  const blob = `${raw}\n** ARCHIVE SUCCEEDED **\nerror: Dangling bundle symlink (ITMS-90018): GuideAI.app/PlugIns/GuideAILiveActivityExtension.appex -> ../../IntermediateBuildFilesPath/UninstalledProducts/iphoneos/GuideAILiveActivityExtension.appex`;
  const msg = explainDeployFailure(raw, blob);
  assert.match(msg, /PlugIns\/\.appex alias/);
  assert.match(msg, /UninstalledProducts/);
  assert.match(msg, /Dangling bundle symlink/);
  assert.doesNotMatch(msg, /TestFlight\/ASC/);
});

test("explainDeployFailure explains embed-phase archive failures", () => {
  const raw = "build-ios.sh exited 65 after 9m";
  const blob = `${raw}\nHint: Embed Foundation/App Extensions failed. Common fixes:`;
  const msg = explainDeployFailure(raw, blob);
  assert.match(msg, /embedding app\/watch extensions/);
  assert.doesNotMatch(msg, /TestFlight\/ASC/);
});

test("sweepJobArtifacts drops checkout and DerivedData, keeps OTA IPA", async () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bsl-sweep-"));
  const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  fs.mkdirSync(path.join(artifactRoot, "work", jobId, "src"), { recursive: true });
  fs.mkdirSync(path.join(artifactRoot, "builds", jobId, "DerivedData"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(artifactRoot, "builds", jobId, "App.ipa"), "ipa");
  fs.writeFileSync(
    path.join(artifactRoot, "builds", jobId, "xcodebuild-archive.log"),
    "log",
  );
  fs.mkdirSync(path.join(artifactRoot, "www", "ota", jobId), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, "www", "ota", jobId, "App.ipa"), "ota");
  await sweepJobArtifacts(
    {
      tsHost: "",
      controlPort: 1,
      otaPort: 1,
      teamId: "",
      artifactRoot,
      artifactTtlDays: 7,
      githubToken: "",
      cursorApiKey: "",
      guideAiRepo: "",
      toolingRepo: "",
      toolingRef: "main",
      deployEngine: "local",
      apiToken: "",
      allowInsecureApi: true,
    },
    jobId,
  );
  assert.equal(fs.existsSync(path.join(artifactRoot, "work", jobId)), false);
  assert.equal(
    fs.existsSync(path.join(artifactRoot, "builds", jobId, "DerivedData")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(artifactRoot, "builds", jobId, "xcodebuild-archive.log")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(artifactRoot, "www", "ota", jobId, "App.ipa")),
    true,
  );
});
