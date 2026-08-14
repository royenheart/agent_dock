const test = require("node:test");
const assert = require("node:assert/strict");
const { parsePorcelainZ, buildRepoStatus, parentPosix, isWithin } = require("../../out/git/parse");

test("parsePorcelainZ: regular + rename + untracked (-z NUL-delimited)", () => {
  const out = parsePorcelainZ(
    " D b.txt\0RM renamed.txt\0a.txt\0?? c.txt\0?? sub/d.txt\0",
    1000,
  );
  assert.equal(out.truncated, false);
  assert.deepEqual(out.files, [
    { path: "b.txt", kind: "deleted", xy: " D" },
    { path: "renamed.txt", originalPath: "a.txt", kind: "renamed", xy: "RM" },
    { path: "c.txt", kind: "untracked", xy: "??" },
    { path: "sub/d.txt", kind: "untracked", xy: "??" },
  ]);
});

test("parsePorcelainZ: conflict / added / modified classification", () => {
  const out = parsePorcelainZ("UU a\0AA b\0DD c\0A  d\0 M e\0!! f\0", 1000);
  assert.deepEqual(
    out.files.map((f) => [f.path, f.kind]),
    [
      ["a", "conflict"],
      ["b", "conflict"],
      ["c", "conflict"],
      ["d", "added"],
      ["e", "modified"],
      ["f", "ignored"],
    ],
  );
});

test("parsePorcelainZ: truncates at limit", () => {
  const out = parsePorcelainZ(" M a\0 M b\0 M c\0 M d\0", 2);
  assert.equal(out.truncated, true);
  assert.equal(out.files.length, 2);
  assert.deepEqual(out.files.map((f) => f.path), ["a", "b"]);
});

test("parsePorcelainZ: empty output / trailing empty segments", () => {
  assert.deepEqual(parsePorcelainZ("", 10), { files: [], truncated: false });
  assert.deepEqual(parsePorcelainZ("\0\0", 10), { files: [], truncated: false });
});

test("buildRepoStatus: file map + directory rollup to repo root", () => {
  const st = buildRepoStatus(
    "/repo",
    [
      { path: "/repo/src/a.txt", kind: "modified", xy: " M" },
      { path: "/repo/x.txt", kind: "untracked", xy: "??" },
    ],
    false,
    123,
  );
  assert.equal(st.root, "/repo");
  assert.equal(st.truncated, false);
  assert.equal(st.scannedAt, 123);
  assert.equal(st.files.get("/repo/src/a.txt").kind, "modified");
  // 目录聚合：/repo/src → modified；/repo → modified（modified 优先于 untracked）
  assert.equal(st.dirs.get("/repo/src"), "modified");
  assert.equal(st.dirs.get("/repo"), "modified");
});

test("buildRepoStatus: relative porcelain paths are absolutized against root", () => {
  // 真实 git status 输出是相对仓库根的路径（如 sub/c.txt），必须归一为绝对路径才能按绝对路径反查
  const st = buildRepoStatus(
    "/repo",
    [
      { path: "a.txt", kind: "modified", xy: " M" },
      { path: "sub/c.txt", kind: "untracked", xy: "??" },
    ],
    false,
    0,
  );
  assert.equal(st.files.get("/repo/a.txt").kind, "modified");
  assert.equal(st.files.get("/repo/sub/c.txt").kind, "untracked");
  assert.equal(st.dirs.get("/repo/sub"), "untracked");
  assert.equal(st.dirs.get("/repo"), "modified");
});

test("buildRepoStatus: repo root / handling", () => {
  const st = buildRepoStatus("/", [{ path: "/tmp/f.txt", kind: "added", xy: "A " }], false, 0);
  assert.equal(st.dirs.get("/tmp"), "added");
  assert.equal(st.dirs.get("/"), "added");
});

test("parentPosix / isWithin edge cases", () => {
  assert.equal(parentPosix("/a/b/c"), "/a/b");
  assert.equal(parentPosix("/a"), "/");
  assert.equal(parentPosix("/"), undefined);
  assert.equal(parentPosix("a"), undefined);
  assert.equal(isWithin("/a/b", "/a"), true);
  assert.equal(isWithin("/a", "/a"), true);
  assert.equal(isWithin("/ab", "/a"), false);
  assert.equal(isWithin("/a", "/"), true);
});
