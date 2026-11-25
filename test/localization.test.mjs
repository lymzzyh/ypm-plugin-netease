// 使用独立 ESM 上下文加载真实插件，验证翻译不会改变接口参数或音乐元数据。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "plugin.json")));
const dictionaries = Object.fromEntries(readdirSync(path.join(root, "locales")).map((name) => [
  name.slice(0, -5), JSON.parse(readFileSync(path.join(root, "locales", name))),
]));
const sourceKeys = new Set();
for (const file of ["index.js", "client.js", "models.js"]) {
  for (const match of readFileSync(path.join(root, file), "utf8").matchAll(/"([^"\n]*[\u3400-\u9fff][^"\n]*)"/g)) {
    if (match[1] !== "playlists:全部:0") sourceKeys.add(match[1]);
  }
}
sourceKeys.add(manifest.name);
sourceKeys.add(manifest.description);
for (const entry of manifest.navigation) if (entry.title) sourceKeys.add(entry.title);
for (const item of manifest.settings || []) {
  sourceKeys.add(item.label); if (item.help) sourceKeys.add(item.help);
  for (const option of item.options || []) sourceKeys.add(option.label);
}

async function runtime(language = "en") {
  const store = new Map();
  const prompts = [], requests = [];
  let payload;
  const env = { language, status: 200, body: null, settings: {} };
  const context = vm.createContext({
    URL, URLSearchParams, AbortSignal, console,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)),
    host: {
      setting: (key) => env.settings[key] ?? "",
      t: (message) => dictionaries[env.language]?.[message] ?? message,
      storage: { get: (key) => store.get(key), set: (key, value) => store.set(key, value), remove: (key) => store.delete(key) },
      crypto: { md5: () => "fixture", aesEcbEncrypt: (_, text) => { payload = JSON.parse(text.split("-36cd479b6b5-")[1]); return "fixture"; } },
      signInPrompt: (value = {}) => prompts.push(value),
    },
    fetch: async (url) => {
      requests.push({ url, payload });
      const body = env.reply ? env.reply(payload, url) : env.body ?? (url.includes("/unikey") ? { code: 200, unikey: "fixture-qr" }
        : url.includes("/client/login") ? { code: -462 } : { code: 200, more: true, playlists: [] });
      return { ok: env.status === 200, status: env.status, headers: { getSetCookie: () => [] }, json: async () => body };
    },
  });
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    assert.ok(!path.relative(root, file).startsWith(".."));
    const mod = new vm.SourceTextModule(readFileSync(file, "utf8"), { context, identifier: file });
    modules.set(file, mod);
    return mod;
  }
  const main = load(path.join(root, "index.js"));
  await main.link((specifier, ref) => load(path.resolve(path.dirname(ref.identifier), specifier)));
  await main.evaluate();
  return { env, store, prompts, requests, plugin: main.namespace, models: modules.get(path.join(root, "models.js")).namespace, i18n: modules.get(path.join(root, "i18n.js")).namespace };
}

test("收藏专辑兼容音乐库的数组读取，保留分页参数且空页结束", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture-session" });
  r.store.set("account", { id: "42", name: "测试用户" });
  for (const offset of [0, 50]) {
    r.env.body = { code: 200, hasMore: offset === 0, data: [{
      id: offset + 1, name: "测试专辑", picUrl: "http://p1.music.126.net/cover.jpg",
      artists: [{ id: 3, name: "歌手" }], size: 12, publishTime: 1700000000000,
    }] };
    const albums = await r.plugin.savedAlbums({ offset });
    // 播放器音乐库直接按 List 读取，包括 hasMore 为 false 的最后一个非空页。
    assert.ok(Array.isArray(albums));
    assert.equal(albums.length, 1);
    assert.equal(albums[0].id, String(offset + 1));
    assert.equal(albums[0].saved, true);
    assert.equal(albums[0].artists[0].name, "歌手");
    assert.equal(albums[0].imageUrl, "https://p1.music.126.net/cover.jpg");
    assert.equal(r.requests.at(-1).payload.offset, offset);
    assert.equal(r.requests.at(-1).payload.limit, 50);
  }
  r.env.body = { code: 200, hasMore: false, data: [] };
  assert.equal((await r.plugin.savedAlbums({ offset: 100 })).length, 0);
  r.env.body = { code: 200 };
  assert.ok(Array.isArray(await r.plugin.savedAlbums({ offset: 0 })));
});

test("收藏歌曲按收藏时间倒序，并缓存排序结果", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture-session" });
  r.store.set("account", { id: "42", name: "测试用户" });
  r.env.reply = (payload) => {
    if (payload.uid && payload.limit) return { code: 200, more: false, playlist: [{ id: 7, specialType: 5 }] };
    if (payload.id === "7") return { code: 200, playlist: { trackIds: [{ id: 1, at: 100 }, { id: 2, at: 300 }, { id: 3, at: 200 }] } };
    if (payload.c) {
      return { code: 200, songs: JSON.parse(payload.c).map((x) => ({ id: x.id, name: `歌曲${x.id}`, ar: [], al: {}, dt: 1000 })), privileges: [] };
    }
    return { code: 200, ids: [1, 2, 3] };
  };
  const page = await r.plugin.liked({ offset: 0 });
  assert.equal(page.tracks.map((t) => t.id).join(","), "2,3,1");
  assert.equal(page.more, false);
  // 详情请求必须带上按收藏时间排好的 id，而不是接口原始顺序。
  assert.equal(r.requests.at(-1).payload.c, '[{"id":"2"},{"id":"3"},{"id":"1"}]');
  // 只需要 trackIds，不拉整张歌单的详情。
  assert.equal(r.requests.find((q) => q.payload.id === "7").payload.n, 0);
  assert.equal(r.store.get("likedIds").join(","), "2,3,1");
  const before = r.requests.length;
  const cached = await r.plugin.liked({ offset: 0 });
  // 排序结果走缓存：只多出本页的歌曲详情请求，不重新查找歌单。
  assert.equal(r.requests.length, before + 1);
  assert.equal(r.requests.filter((q) => q.payload.uid && q.payload.limit).length, 1);
  assert.equal(cached.tracks.map((t) => t.id).join(","), "2,3,1");
});

test("拿不到收藏时间时退回 like/get 的原始顺序", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture-session" });
  r.store.set("account", { id: "42", name: "测试用户" });
  r.env.reply = (payload) => {
    if (payload.uid && payload.limit) return { code: 200, more: false, playlist: [{ id: 7, specialType: 0 }] };
    if (payload.c) {
      return { code: 200, songs: JSON.parse(payload.c).map((x) => ({ id: x.id, name: `歌曲${x.id}`, ar: [], al: {}, dt: 1000 })), privileges: [] };
    }
    return { code: 200, ids: [5, 4] };
  };
  const page = await r.plugin.liked({ offset: 0 });
  assert.equal(page.tracks.map((t) => t.id).join(","), "5,4");
});

test("心动模式按当前歌曲续推，过滤 seed 与重复项", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture-session" });
  r.store.set("account", { id: "42", name: "测试用户" });
  r.store.set("likedListId", "7");
  const song = (id, name) => ({ id, name, ar: [{ id: 1, name: "歌手" }], al: { id: 2, name: "专辑" }, dt: 1000, privilege: { st: 0 } });
  r.env.reply = (payload) => {
    if (payload.type === "fromPlayOne") {
      return { code: 200, data: [
        { id: 1, songInfo: song(1, "推荐一") },
        { id: 2, songInfo: song(2, "推荐二") },
        { id: 3, songInfo: song(3, "推荐三") },
        { id: 1, songInfo: song(1, "推荐一") },
        { id: 99, songInfo: song(99, "当前歌曲") },
      ] };
    }
    if (payload.c) return { code: 200, songs: [song(99, "当前歌曲")], privileges: [] };
    return { code: 200, data: [] };
  };
  const page = await r.plugin.station({ id: "heartbeat", seed: "99" });
  // 队首是 seed 本身：宿主换队列时会继续播完当前歌曲，再进入推荐
  assert.equal(page.tracks.map((t) => t.id).join(","), "99,1,2,3");
  assert.equal(page.more, true);
  const request = r.requests.find((q) => q.payload.type === "fromPlayOne").payload;
  assert.equal(request.songId, "99");
  assert.equal(request.startMusicId, "99");
  assert.equal(request.playlistId, "7");
  assert.equal(request.count, 100);
  assert.equal(r.requests.find((q) => q.payload.c).payload.c, '[{"id":"99"}]');

  // 右键菜单把这首歌作为 seed 交给电台。
  const action = r.plugin.menuAction({ id: "heartbeat", track: { id: "99" } });
  assert.equal(action.station.id, "heartbeat");
  assert.equal(action.station.seed, "99");
  assert.ok(r.plugin.trackMenu().some((item) => item.id === "heartbeat"));

  // 登录后首页有心动模式入口。
  const home = await r.plugin.home();
  assert.ok(home.sections.find((section) => section.style === "modes").modes.some((m) => m.station === "heartbeat"));
});

test("心动模式没有 seed 时用最近播放，未登录和未知电台给出对应错误", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture-session" });
  r.store.set("account", { id: "42", name: "测试用户" });
  r.store.set("likedListId", "7");
  r.env.reply = (payload) => {
    if (payload.type === "fromPlayOne") return { code: 200, data: [{ songInfo: { id: 5, name: "推荐", ar: [], al: {}, dt: 1 } }] };
    if (payload.limit === 50) return { code: 200, data: { list: [{ data: { id: 77, name: "最近播放", ar: [], al: {}, dt: 1 } }] } };
    return { code: 200 };
  };
  await r.plugin.station({ id: "heartbeat" });
  assert.equal(r.requests.find((q) => q.payload.type === "fromPlayOne").payload.songId, "77");
  // 没有显式 seed 时不往队首塞歌，直接播推荐
  assert.ok(!r.requests.some((q) => q.payload.c));
  await assert.rejects(r.plugin.station({ id: "unknown" }), (e) => e.code === "unsupported");
  const guest = await runtime("zh-CN");
  await assert.rejects(guest.plugin.station({ id: "heartbeat", seed: "1" }), (e) => e.code === "signIn");
});

test("歌单详情带上心动模式电台 id", async () => {
  const r = await runtime("zh-CN");
  r.env.reply = () => ({
    code: 200,
    playlist: { id: 9, name: "测试歌单", trackCount: 0, trackIds: [], tracks: [], creator: { userId: 1 } },
  });
  const page = await r.plugin.playlist({ id: "9" });
  assert.equal(page.station, "heartbeat");
  assert.equal(page.name, "测试歌单");
});

test("首页把心动模式排在小行，前两张大卡有内容", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture-session" });
  r.store.set("account", { id: "42", name: "测试用户" });
  const track = (id, name) => ({
    id, name, ar: [{ id: 1, name: "歌手" }],
    al: { id: 2, name: "专辑", picUrl: "http://p1.music.126.net/a.jpg" }, dt: 1000,
  });
  r.env.reply = (payload) => {
    if (payload.limit === 24) {
      return { code: 200, result: [
        { id: 77, name: "推荐歌单一", picUrl: "http://p1.music.126.net/a.jpg", creator: { nickname: "网易云" }, playCount: 10, trackCount: 5 },
        { id: 88, name: "推荐歌单二", picUrl: "http://p1.music.126.net/b.jpg", creator: { nickname: "网易云" }, playCount: 5, trackCount: 3 },
      ] };
    }
    if (payload.uid) return { code: 200, playlist: [{ id: 7, specialType: 5, coverImgUrl: "http://p1.music.126.net/liked.jpg" }] };
    if (payload.limit === 50) return { code: 200, data: { list: [{ data: track(5, "最近一") }] } };
    return { code: 200, data: { dailySongs: [track(1, "日推一"), track(2, "日推二")] } };
  };
  const home = await r.plugin.home();
  const modes = home.sections.find((s) => s.style === "modes").modes;
  // 大卡：每日推荐 + 推荐歌单；小行：心动模式 / 我喜欢的音乐 / 最近播放，正好填满一行
  assert.equal(modes.length, 5);
  assert.equal(modes[0].tracks.map((t) => t.id).join(","), "1,2");
  assert.equal(modes[1].playlist, "77");
  assert.equal(modes[2].station, "heartbeat");
  assert.equal(modes[3].playlist, "7");
  assert.equal(modes[3].imageUrl, "http://p1.music.126.net/liked.jpg");
  assert.equal(modes[4].tracks.map((t) => t.id).join(","), "5");
  // 大卡用掉的推荐歌单不再重复出现在下面的歌单架里
  assert.equal(home.sections.find((s) => s.style === "shelf").playlists.map((p) => p.id).join(","), "88");
  // 有日推大卡时不再重复放每日推荐链接
  assert.ok(!home.sections.some((s) => s.links?.some((l) => l.page === "daily")));
});

test("九种语言覆盖全部文案，动态占位符保持一致", () => {
  assert.deepEqual(Object.keys(dictionaries).sort(), ["de", "en", "es", "fr", "ja", "ko", "ru", "zh-CN", "zh-TW"].sort());
  for (const [locale, messages] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(messages).sort(), [...sourceKeys].sort(), locale);
    for (const [key, value] of Object.entries(messages)) {
      assert.ok(typeof value === "string" && value.length > 0, `${locale}: ${key}`);
      const slots = (text) => [...text.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
      assert.deepEqual(slots(value), slots(key), `${locale}: ${key}`);
      if (locale === "zh-CN") assert.equal(value, key);
      else if (locale !== "zh-TW" && locale !== "ja") assert.ok(!/[\u3400-\u9fff]/.test(value), `${locale}: ${key}`);
    }
  }
});

for (const locale of Object.keys(dictionaries)) {
  test(`${locale}：导航、分类、占位、错误和扫码提示均使用当前语言`, async () => {
    const r = await runtime(locale);
    const d = dictionaries[locale];
    const page = await r.plugin.browse({ page: "playlists:华语:0" });
    assert.equal(page.title, d["热门歌单"]);
    assert.equal(page.tabs[1].title, d["华语"]);
    assert.equal(page.tabs[1].page, "playlists:华语:0");
    assert.equal(r.requests[0].payload.cat, "华语");
    assert.equal(page.sections[1].links[0].title, d["下一页"]);
    assert.equal(r.models.track({}).name, d["未知歌曲"]);
    assert.equal(r.models.track({ name: "每日推荐" }).name, "每日推荐");
    await assert.rejects(r.plugin.liked({}), (e) => e.code === "signIn" && e.message === d["请先登录网易云音乐"]);
    await assert.rejects(r.plugin.signIn(), (e) => e.code === "failed");
    assert.ok(r.prompts.some((p) => p.text === d["请用网易云音乐 App 扫码，并在手机上确认登录"]));
    assert.ok(r.prompts.some((p) => p.qr === "https://music.163.com/login?codekey=fixture-qr"));
  });
}

test("切换语言立即生效，服务端占位符不被二次替换", async () => {
  const r = await runtime("en");
  assert.equal((await r.plugin.home()).title, "NetEase Cloud Music");
  r.env.language = "zh-TW";
  assert.equal((await r.plugin.home()).title, "網易雲音樂");
  r.env.language = "en";
  r.env.status = 503;
  await assert.rejects(r.plugin.home(), (e) => e.retryable && e.message.includes("HTTP 503"));
  r.env.status = 200;
  r.env.body = { code: 403, message: "服务端消息 {status}" };
  await assert.rejects(r.plugin.home(), (e) => e.message === "NetEase request failed (403): 服务端消息 {status}");
  assert.equal(r.i18n.t("网易云请求失败（{code}）：{message}", { code: 1, message: "$& {code}" }), "NetEase request failed (1): $& {code}");
});

test("README 互链、仓库安装地址和许可证一致", () => {
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const text = readFileSync(path.join(root, name), "utf8");
    assert.ok(text.includes("github.com/lymzzyh/ypm-plugin-netease"));
    assert.ok(text.includes(name === "README.md" ? "(README.zh-CN.md)" : "(README.md)"));
    assert.ok(text.includes("[MIT](LICENSE)"));
  }
  assert.ok(readFileSync(path.join(root, "LICENSE"), "utf8").startsWith("MIT License"));
});

test("音质设置优先于播放器默认值，空设置跟随播放器", async () => {
  const levels = { standard: "standard", high: "exhigh", lossless: "lossless", hires: "hires" };
  for (const [selected, expected] of Object.entries(levels)) {
    const r = await runtime("zh-CN");
    r.env.settings.quality = selected;
    r.env.reply = (payload) => ({ code: 200, data: [{ url: "https://m.music.126.net/fixture", level: payload.level }] });
    assert.equal((await r.plugin.stream({ id: "42", quality: "high" })).quality, expected);
    assert.equal(r.requests[0].payload.level, expected);
  }
  for (const selected of ["", "invalid"]) {
    const r = await runtime(); r.env.settings.quality = selected;
    r.env.reply = (payload) => ({ code: 200, data: [{ url: "https://m.music.126.net/fixture", level: payload.level }] });
    assert.equal((await r.plugin.stream({ id: "42", quality: "lossless" })).quality, "lossless");
  }
});

test("Hi-Res 无完整音频时按序降级，不返回试听，也不向上请求", async () => {
  const r = await runtime("zh-CN"); r.env.settings.quality = "hires";
  r.env.reply = (payload) => ({ code: 200, data: [payload.level === "exhigh" ? { url: "https://m.music.126.net/full", level: "exhigh" } : { url: "https://m.music.126.net/preview", freeTrialInfo: { start: 0 } }] });
  assert.equal((await r.plugin.stream({ id: "42" })).quality, "exhigh");
  assert.deepEqual(r.requests.map(q => q.payload.level), ["hires", "lossless", "exhigh"]);
  r.env.settings.quality = "standard"; r.requests.length = 0;
  await assert.rejects(r.plugin.stream({ id: "42" }), e => e.code === "unavailable");
  assert.deepEqual(r.requests.map(q => q.payload.level), ["standard"]);
});

test("登录失效和网络错误立即报告，不伪装成音质降级", async () => {
  const r = await runtime(); r.env.settings.quality = "hires";
  r.env.body = { code: 301 };
  await assert.rejects(r.plugin.stream({ id: "42" }), e => e.code === "signIn");
  assert.equal(r.requests.length, 1);
  r.requests.length = 0; r.env.status = 503;
  await assert.rejects(r.plugin.stream({ id: "42" }), e => e.retryable === true);
  assert.equal(r.requests.length, 1);
});

test("云盘要求登录；未登录不请求个人数据", async () => {
  const r = await runtime("zh-CN");
  await assert.rejects(r.plugin.browse({ page: "cloud" }), e => e.code === "signIn");
  assert.equal(r.requests.length, 0);
});

test("云盘分页保留歌曲编号、元数据和翻页位置", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture" }); r.store.set("account", { id: "42" });
  r.env.reply = (p, url) => {
    assert.ok(url.endsWith("/eapi/v1/cloud/get")); assert.equal(p.limit, 50);
    return { code: 200, count: 100, hasMore: p.offset === 0, data: Array.from({ length: 50 }, (_, i) => ({
      songId: String(1000 + p.offset + i), songName: "个人上传", artist: "原始歌手", album: "个人专辑", cover: "http://p1.music.126.net/cover.jpg",
      simpleSong: { id: 1, name: "公共曲库名称", dt: 180000, ar: [{ id: 2, name: "歌手" }], al: { id: 3, name: "专辑" }, privilege: { st: -200 }, noCopyrightRcmd: { type: 1 } },
    })) };
  };
  const page = await r.plugin.browse({ page: "cloud" });
  assert.equal(page.title, "我的云盘"); assert.equal(page.sections[0].tracks.length, 50);
  const t = page.sections[0].tracks[0];
  assert.equal(t.id, "1000"); assert.equal(t.name, "个人上传"); assert.equal(t.duration, 180000); assert.equal(t.unavailable, false);
  assert.equal(t.album.name, "个人专辑"); assert.equal(t.album.imageUrl, "https://p1.music.126.net/cover.jpg");
  assert.equal(page.sections[1].links[0].page, "cloud:50");
  const last = await r.plugin.browse({ page: "cloud:50" });
  assert.equal(r.requests.at(-1).payload.offset, 50);
  assert.equal(last.sections[1].links.length, 1); assert.equal(last.sections[1].links[0].page, "cloud:0");
});

test("云盘原始文件无需公共匹配；缺少编号不允许播放", async () => {
  const r = await runtime("zh-CN");
  const t = r.models.cloudTrack({ songId: "900001", fileName: "我的录音.flac", artist: "本人", album: "录音" });
  assert.equal(t.id, "900001"); assert.equal(t.name, "我的录音.flac"); assert.equal(t.artists[0].name, "本人"); assert.equal(t.unavailable, false);
  assert.equal(r.models.cloudTrack({ fileName: "无编号文件" }).unavailable, true);
  r.env.settings.quality = "lossless";
  r.env.reply = p => { assert.deepEqual(JSON.parse(p.ids), ["900001"]); return { code: 200, data: [{ url: "https://m.music.126.net/private-file", level: "lossless", type: "flac" }] }; };
  assert.equal((await r.plugin.stream({ id: t.id })).quality, "lossless");
});

test("空云盘、空末页与缺少 hasMore 时均正确停止分页", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture" }); r.store.set("account", { id: "42" });
  r.env.body = { code: 200, data: [], count: 0, hasMore: false };
  const empty = await r.plugin.browse({ page: "cloud" });
  assert.equal(empty.sections.length, 1); assert.equal(empty.sections[0].tracks.length, 0); assert.equal(empty.sections[0].empty, "云盘中还没有歌曲");
  r.env.body = { code: 200, data: [], hasMore: true };
  const last = await r.plugin.browse({ page: "cloud:50" });
  assert.equal(last.sections[1].links.length, 1); assert.equal(last.sections[1].links[0].title, "上一页");
  r.env.body = { code: 200, data: [{ songId: 1 }], count: 2 };
  assert.equal((await r.plugin.browse({ page: "cloud" })).sections[1].links[0].page, "cloud:1");
});

test("云盘参数和异常响应不会伪装成空音乐库", async () => {
  const r = await runtime();r.store.set("cookies", { MUSIC_U: "fixture" });r.store.set("account", { id: "42" });
  for (const page of ["cloud:-1", "cloud:abc", "cloud:9007199254740993", "cloud:0:1"]) await assert.rejects(r.plugin.browse({ page }), e => e.code === "unsupported");
  assert.equal(r.requests.length, 0);
  r.env.body = { code: 200, data: {} };
  await assert.rejects(r.plugin.browse({ page: "cloud" }), e => e.code === "failed");
  r.env.body = { code: 301 };
  await assert.rejects(r.plugin.browse({ page: "cloud" }), e => e.code === "signIn");
});

test("云盘可从发现页进入，新版宿主通过筛选标签翻页", async () => {
  const r = await runtime("zh-CN");
  r.env.body = { code: 200, playlists: [], more: false };
  assert.ok((await r.plugin.browse({})).tabs.some(t => t.page === "cloud" && t.title === "我的云盘"));
  r.store.set("cookies", { MUSIC_U: "fixture" });r.store.set("account", { id: "42" });
  r.env.body = { code: 200, data: [{ songId: 123 }], hasMore: true };
  const page = await r.plugin.browse({ page: "cloud" });
  assert.equal(page.filters[0][0].page, "cloud:1");
  assert.ok(page.tabs.some(t => t.page === "cloud" && t.selected));
  assert.ok(page.tabs.some(t => t.page === ""));
});

test("喜欢的歌曲按红心歌单顺序返回并附带收藏时间，分页复用快照且补齐缺失曲目", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture" });
  r.store.set("account", { id: "42", name: "测试用户" });
  const total = 52;
  const baseAt = 1730000000000;
  const trackIds = Array.from({ length: total }, (_, i) => ({
    id: 2000 - i,
    at: i === total - 1 ? 0 : baseAt - i * 1000,
  }));
  const firstBatch = trackIds.slice(0, 50).map(({ id }) => ({
    id, name: `Song ${id}`, dt: 180000, ar: [{ id: 1, name: "Artist" }], al: { id: 2, name: "Album" },
  }));
  r.env.reply = (p, url) => {
    if (url.endsWith("/eapi/user/playlist")) {
      return {
        code: 200, more: false, playlist: [
          { id: 100, name: "别人的红心", specialType: 5, creator: { userId: 99 } },
          { id: 101, name: "普通歌单", specialType: 0, creator: { userId: 42 } },
          { id: 555, name: "我喜欢的音乐", specialType: 5, creator: { userId: 42 } },
        ],
      };
    }
    if (url.endsWith("/eapi/v6/playlist/detail")) {
      assert.equal(p.id, "555");
      return {
        code: 200,
        playlist: { id: 555, name: "我喜欢的音乐", specialType: 5, creator: { userId: 42 }, trackCount: total, tracks: firstBatch, trackIds },
        privileges: firstBatch.map((x) => ({ id: x.id, st: 0 })),
      };
    }
    if (url.endsWith("/eapi/v3/song/detail")) {
      const ids = JSON.parse(p.c).map((x) => Number(x.id));
      return {
        code: 200,
        songs: ids.map((id) => ({ id, name: `Song ${id}`, dt: 200000, ar: [{ id: 1, name: "Artist" }], al: { id: 2, name: "Album" } })),
        privileges: ids.map((id) => ({ id, st: 0 })),
      };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const page1 = await r.plugin.liked({ offset: 0 });
  assert.equal(page1.tracks.length, 50);
  assert.equal(page1.more, true);
  assert.equal(page1.tracks[0].id, "2000");
  assert.equal(page1.tracks[0].added, new Date(baseAt).toISOString());
  assert.equal(page1.tracks[1].id, "1999");
  assert.equal(page1.tracks[1].added, new Date(baseAt - 1000).toISOString());
  assert.equal(r.requests.filter((q) => q.url.endsWith("/eapi/v3/song/detail")).length, 0);

  const page2 = await r.plugin.liked({ offset: 50 });
  assert.equal(page2.tracks.length, 2);
  assert.equal(page2.more, false);
  assert.equal(page2.tracks[0].id, "1950");
  assert.equal(page2.tracks[0].added, new Date(baseAt - 50 * 1000).toISOString());
  assert.equal(page2.tracks[1].id, "1949");
  assert.equal("added" in page2.tracks[1], false);
  assert.equal(r.requests.filter((q) => q.url.endsWith("/eapi/user/playlist")).length, 1);
  assert.equal(r.requests.filter((q) => q.url.endsWith("/eapi/v6/playlist/detail")).length, 1);
  assert.equal(r.requests.filter((q) => q.url.endsWith("/eapi/v3/song/detail")).length, 1);
});

test("红心操作、登出和切换账号均会失效喜欢歌曲缓存", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "u1" });
  r.store.set("account", { id: "42", name: "用户一" });
  let version = 1;
  r.env.reply = (p, url) => {
    if (url.endsWith("/eapi/user/playlist")) {
      const pid = p.uid === "42" ? 555 : 666;
      return { code: 200, more: false, playlist: [{ id: pid, name: "我喜欢的音乐", specialType: 5, creator: { userId: Number(p.uid) } }] };
    }
    if (url.endsWith("/eapi/v6/playlist/detail")) {
      const ids = p.id === "555" ? (version === 1 ? [10] : [20, 10]) : [30];
      return {
        code: 200,
        playlist: {
          id: Number(p.id), specialType: 5, trackCount: ids.length,
          tracks: ids.map((id) => ({ id, name: `Song ${id}`, dt: 1000 })),
          trackIds: ids.map((id, i) => ({ id, at: 1730000000000 - i * 1000 })),
        },
        privileges: ids.map((id) => ({ id, st: 0 })),
      };
    }
    if (url.endsWith("/eapi/radio/like")) return { code: 200 };
    throw new Error(`unexpected url: ${url}`);
  };
  assert.deepEqual((await r.plugin.liked({ offset: 0 })).tracks.map((t) => t.id), ["10"]);
  version = 2;
  await r.plugin.like({ id: "20", on: true });
  assert.deepEqual((await r.plugin.liked({ offset: 0 })).tracks.map((t) => t.id), ["20", "10"]);
  assert.equal(r.requests.filter((q) => q.url.endsWith("/eapi/user/playlist")).length, 1);

  r.plugin.signOut();
  r.store.set("cookies", { MUSIC_U: "u2" });
  r.store.set("account", { id: "43", name: "用户二" });
  assert.deepEqual((await r.plugin.liked({ offset: 0 })).tracks.map((t) => t.id), ["30"]);
  assert.equal(r.requests.filter((q) => q.url.endsWith("/eapi/user/playlist")).length, 2);
});

test("缺少红心歌单时回退到喜欢编号列表，登录失效错误直接上报", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture" });
  r.store.set("account", { id: "42", name: "新用户" });
  r.env.reply = (p, url) => {
    if (url.endsWith("/eapi/user/playlist")) return { code: 200, more: false, playlist: [] };
    if (url.endsWith("/eapi/song/like/get")) return { code: 200, ids: [7, 8] };
    if (url.endsWith("/eapi/v3/song/detail")) {
      const ids = JSON.parse(p.c).map((x) => Number(x.id));
      return { code: 200, songs: ids.map((id) => ({ id, name: `Song ${id}`, dt: 1000 })), privileges: ids.map((id) => ({ id, st: 0 })) };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const fallback = await r.plugin.liked({ offset: 0 });
  assert.deepEqual(fallback.tracks.map((t) => t.id), ["7", "8"]);
  assert.equal("added" in fallback.tracks[0], false);

  const r2 = await runtime("zh-CN");
  r2.store.set("cookies", { MUSIC_U: "expired" });
  r2.store.set("account", { id: "42", name: "用户" });
  r2.env.reply = (p, url) => {
    if (url.endsWith("/eapi/user/playlist")) {
      return { code: 200, more: false, playlist: [{ id: 555, specialType: 5, creator: { userId: 42 } }] };
    }
    if (url.endsWith("/eapi/v6/playlist/detail")) return { code: 301 };
    throw new Error(`unexpected url: ${url}`);
  };
  await assert.rejects(r2.plugin.liked({ offset: 0 }), (e) => e.code === "signIn");
  assert.equal(r2.requests.filter((q) => q.url.endsWith("/eapi/song/like/get")).length, 0);
});

test("歌单详情保留添加时间，且读取歌单列表后喜欢的歌曲复用了红心歌单编号", async () => {
  const r = await runtime("zh-CN");
  r.store.set("cookies", { MUSIC_U: "fixture" });
  r.store.set("account", { id: "42", name: "用户" });
  r.env.reply = (p, url) => {
    if (url.endsWith("/eapi/user/playlist")) {
      return { code: 200, more: false, playlist: [{ id: 555, name: "我喜欢的音乐", specialType: 5, creator: { userId: 42 } }] };
    }
    if (url.endsWith("/eapi/v6/playlist/detail")) {
      return {
        code: 200,
        playlist: {
          id: 555, name: "我喜欢的音乐", specialType: 5, creator: { userId: 42 }, trackCount: 2,
          tracks: [{ id: 101, name: "First", dt: 1000 }],
          trackIds: [{ id: 101, at: 1730000000000 }, { id: 102, at: 0 }],
        },
        privileges: [{ id: 101, st: 0 }],
      };
    }
    if (url.endsWith("/eapi/v3/song/detail")) {
      return { code: 200, songs: [{ id: 102, name: "Second", dt: 1000 }], privileges: [{ id: 102, st: 0 }] };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const pls = await r.plugin.playlists();
  assert.equal(pls[0].fixed, true);
  const pl = await r.plugin.playlist({ id: "555" });
  assert.equal(pl.tracks[0].added, new Date(1730000000000).toISOString());
  assert.equal("added" in pl.tracks[1], false);
  const lk = await r.plugin.liked({ offset: 0 });
  assert.deepEqual(lk.tracks.map((t) => t.id), ["101", "102"]);
  assert.equal(r.requests.filter((q) => q.url.endsWith("/eapi/user/playlist")).length, 1);
});
