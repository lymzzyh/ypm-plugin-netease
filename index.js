import { api, fail, id, hasSession, requireAccount, resetSession, verify } from "./client.js";
import * as model from "./models.js";
import { t } from "./i18n.js";

const PAGE = 50;
const LIKED_TTL = 30000;
const LIKED_PAGE_TTL = 5 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const offsetOf = (value) => Math.max(0, Math.floor(Number(value) || 0));
const currentId = () => host.storage.get("account")?.id || "";
const sessionKey = (userId) => `${userId}:${host.storage.get("sessionEpoch") || 0}`;
const attachAdded = (track, added) => (track && added ? { ...track, added } : track);
const isLikedPlaylist = (x, userId) => Boolean(userId) && String(x?.creator?.userId ?? x?.userId ?? "") === userId && Number(x?.specialType) === 5;
let loginSequence = 0;
let likedPlaylistCache = null;
let likedCache = null;

export async function account() {
  if (!hasSession()) return null;
  try { return await verify(); }
  catch (e) {
    // 网络错误保留会话，只有确实过期时才清掉。
    if (e.code !== "signIn") throw e;
    resetSession();
    return null;
  }
}

export async function signIn() {
  // 生成新二维码时保留原会话；用户取消或网络失败不会登出已有账号。
  const original = host.storage.get("cookies");
  const originalAccount = host.storage.get("account");
  const epoch = host.storage.get("sessionEpoch") || 0;
  const sequence = ++loginSequence;
  const deadline = Date.now() + 8 * 60 * 1000;
  let succeeded = false;
  function current() {
    if (sequence !== loginSequence || (host.storage.get("sessionEpoch") || 0) !== epoch) {
      fail("signIn", "扫码登录已取消，请重新点击登录");
    }
    if (Date.now() >= deadline) fail("signIn", "扫码登录超时，请重新点击登录");
  }
  // 取新码或检查状态的短暂网络失败不能直接结束整个登录流程。
  async function request(path, data, options, qr = "") {
    for (let retry = 0; ; retry++) {
      current();
      try {
        const result = await api(path, data, options);
        current();
        return result;
      } catch (e) {
        current();
        if (!e.retryable || retry >= 2) throw e;
        host.signInPrompt({ qr, text: t("网络暂时不稳定，正在重试…") });
        await sleep(1500 * (retry + 1));
      }
    }
  }
  try {
    // 不限制只能刷新三次；在宿主十分钟时限前主动结束。
    while (Date.now() < deadline) {
      current();
      host.signInPrompt({ text: t("正在获取新的登录二维码…") });
      const keyResult = await request("/api/login/qrcode/unikey", { type: 3 }, { cookies: {}, persist: false });
      const key = keyResult.unikey;
      if (!key) fail("failed", "网易云未返回登录二维码，请稍后重试");
      const qr = `https://music.163.com/login?codekey=${encodeURIComponent(key)}`;
      const created = Date.now();
      host.signInPrompt({ qr, text: t("请用网易云音乐 App 扫码，并在手机上确认登录") });
      // 即使服务端一直返回等待状态，也提前轮换，避免展示已失效的旧码。
      // 次数限制还可应对系统时间被用户向后调整的情况。
      for (let poll = 0; poll < 60 && Date.now() - created < 120000; poll++) {
        await sleep(1800);
        current();
        if (Date.now() - created >= 120000) break;
        const { result, cookies } = await request("/api/login/qrcode/client/login", { key, type: 3 }, {
          cookies: {}, raw: true, persist: false, withCookies: true,
        }, qr);
        switch (Number(result.code)) {
          case 800:
            host.signInPrompt({ text: t("二维码已过期，正在刷新…") });
            poll = 60;
            break;
          case 801:
            host.signInPrompt({ qr, text: t("请用网易云音乐 App 扫码，并在手机上确认登录") });
            break;
          case 802:
            host.signInPrompt({ qr, text: t("已扫码，请在手机上确认登录") });
            break;
          case 803: {
            const result = await verify(cookies, current);
            current();
            succeeded = true;
            return result;
          }
          default:
            fail("failed", "网易云暂时无法完成扫码登录，请先在官方客户端完成安全验证后重试");
        }
      }
    }
    fail("signIn", "扫码登录超时，请重新点击登录");
  } finally {
    // 重新点登录后，旧调用的结果不能清掉新调用的二维码或覆盖其会话。
    if (sequence === loginSequence) host.signInPrompt();
    if (!succeeded && sequence === loginSequence && (host.storage.get("sessionEpoch") || 0) === epoch) {
      host.storage.set("cookies", original ?? null);
      host.storage.set("account", originalAccount ?? null);
    }
  }
}

export function signOut() {
  // 仅退出本插件，避免使用户官方客户端的登录失效。
  loginSequence++;
  likedPlaylistCache = null;
  likedCache = null;
  resetSession();
}

export async function search({ query = "", kind = "tracks", offset = 0 }) {
  if (!query.trim()) return { [kind]: [], more: false };
  const types = { tracks: 1, albums: 10, artists: 100, playlists: 1000 };
  const names = { tracks: "songs", albums: "albums", artists: "artists", playlists: "playlists" };
  const counts = { tracks: "songCount", albums: "albumCount", artists: "artistCount", playlists: "playlistCount" };
  const mappers = { tracks: model.track, albums: model.album, artists: model.artist, playlists: (x) => model.playlist(x, currentId()) };
  if (!types[kind]) fail("unsupported", "不支持这种搜索类型");
  const start = offsetOf(offset);
  const j = await api("/api/cloudsearch/pc", { s: query.trim(), type: types[kind], limit: PAGE, offset: start, total: true });
  const r = j.result || {};
  const items = r[names[kind]] || [];
  // 不把 Array.map 的序号误传成 track 的 privilege 参数。
  const mapped = items.map((x) => mappers[kind](x));
  const total = r[counts[kind]];
  return { [kind]: mapped, more: typeof total === "number" ? start + items.length < total : Boolean(r.hasMore), ...(typeof total === "number" ? { total } : {}) };
}

export async function suggest({ query = "" }) {
  if (!query.trim()) return [];
  const j = await api("/api/search/suggest/web", { s: query.trim() });
  return [...new Set([
    ...(j.result?.songs || []).map((x) => x.name),
    ...(j.result?.artists || []).map((x) => x.name),
    ...(j.result?.albums || []).map((x) => x.name),
  ].filter(Boolean))].slice(0, 10);
}

async function details(ids) {
  if (!ids.length) return [];
  const result = [];
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500).map(id);
    const j = await api("/api/v3/song/detail", { c: JSON.stringify(batch.map((value) => ({ id: value }))) });
    const privileges = new Map((j.privileges || []).map((x) => [String(x.id), x]));
    const songs = new Map((j.songs || []).map((x) => [String(x.id), model.track(x, privileges.get(String(x.id)))]));
    for (const value of batch) {
      result.push(songs.get(value) || { id: value, name: t("歌曲暂不可用"), unavailable: true });
    }
  }
  return result;
}

export async function album({ id: value }) {
  const j = await api(`/api/v1/album/${id(value)}`);
  const privileges = new Map((j.privileges || []).map((x) => [String(x.id), x]));
  const album = model.album(j.album);
  return {
    album,
    tracks: (j.songs || []).map((x) => ({ ...model.track(x, privileges.get(String(x.id))), album })),
  };
}

export async function artist({ id: value }) {
  const artistId = id(value);
  const [j, albums] = await Promise.all([
    api(`/api/v1/artist/${artistId}`),
    api(`/api/artist/albums/${artistId}`, { limit: 100, offset: 0, total: true }),
  ]);
  return { artist: model.artist(j.artist), tracks: (j.hotSongs || []).map((x) => model.track(x)), albums: (albums.hotAlbums || []).map(model.album), related: [] };
}

export async function playlist({ id: value }) {
  const j = await api("/api/v6/playlist/detail", { id: id(value), n: 1000, s: 0 });
  if (!j.playlist) fail("unavailable", "歌单不存在，或没有访问权限");
  const p = j.playlist;
  const entries = (p.trackIds || []).map((x) => ({ id: String(x.id), added: model.timestamp(x.at) }));
  if (entries.length > 10000) fail("unsupported", "该歌单超过一万首，暂不支持一次载入，请拆分后再打开");
  const privileges = new Map((j.privileges || []).map((x) => [String(x.id), x]));
  const known = new Map((p.tracks || []).map((x) => [String(x.id), model.track(x, privileges.get(String(x.id)))]));
  const missing = [...new Set(entries.map((x) => x.id).filter((x) => !known.has(x)))];
  for (const track of await details(missing)) known.set(track.id, track);
  const tracks = entries.length
    ? entries.map(({ id: trackId, added }) => attachAdded(known.get(trackId), added))
    : [...known.values()];
  return { ...model.playlist(p, currentId()), station: HEARTBEAT, tracks, trackCount: p.trackCount ?? tracks.length };
}

export async function playlists() {
  const user = requireAccount();
  const key = sessionKey(user.id);
  const result = [];
  // API 最多 1000 条一页；按 more 取完，不能静默丢失后面的歌单。
  for (let offset = 0; offset < 10000; offset += 1000) {
    const j = await api("/api/user/playlist", { uid: user.id, limit: 1000, offset, includeVideo: false });
    const items = j.playlist || [];
    for (const x of items) {
      const mapped = model.playlist(x, user.id);
      if (mapped.fixed && mapped.id && sessionKey(currentId()) === key) {
        likedPlaylistCache = { key, id: mapped.id };
      }
      result.push(mapped);
    }
    if (!j.more || !items.length) return result;
  }
  fail("unsupported", "账号歌单数量超过插件当前支持范围");
}

// 「我喜欢的音乐」歌单封面；只在第一次需要时取一次。
async function likedCover(listId) {
  const cached = host.storage.get("likedCover");
  if (typeof cached === "string") return cached;
  const j = await api("/api/v6/playlist/detail", { id: listId, n: 0, s: 0 });
  const cover = String(j.playlist?.coverImgUrl || "");
  host.storage.set("likedCover", cover);
  return cover;
}

// 收藏时间由「我喜欢的音乐」歌单的 trackIds[].at 提供；like/get 只返回 id，顺序不是收藏时间。
async function likedOrder(user) {
  const listId = await likedPlaylistId(user);
  if (!listId) return null;
  let j;
  try {
    // n=0 只要 trackIds，不把整张歌单的歌曲详情一起拉下来。
    j = await api("/api/v6/playlist/detail", { id: listId, n: 0, s: 0 });
  } catch (e) {
    // 缓存的歌单编号失效时清掉，下次重新查找；登录问题仍然原样上报。
    if (e.code === "signIn") throw e;
    host.storage.remove("likedListId");
    return null;
  }
  const items = (j.playlist?.trackIds || []).map((x) => [String(x.id), Number(x.at) || 0]);
  if (!items.length) return null;
  // 最新收藏在前；没有时间戳的条目排在最后，并保持接口原有顺序。
  items.sort((a, b) => b[1] - a[1]);
  return items.map(([value]) => value);
}

async function likedIds() {
  const user = requireAccount();
  const cached = host.storage.get("likedIds");
  if (Array.isArray(cached) && Date.now() - (host.storage.get("likedAt") || 0) < LIKED_TTL) return cached;
  const j = await api("/api/song/like/get", { uid: user.id });
  const ids = (j.ids || []).map(String);
  host.storage.set("likedIds", ids);
  host.storage.set("likedAt", Date.now());
  return ids;
}

async function likedPlaylistId(user) {
  const key = sessionKey(user.id);
  if (likedPlaylistCache?.key === key) return likedPlaylistCache.id;
  for (let offset = 0; offset < 10000; offset += 1000) {
    const j = await api("/api/user/playlist", { uid: user.id, limit: 1000, offset, includeVideo: false });
    const items = j.playlist || [];
    const found = items.find((x) => isLikedPlaylist(x, user.id));
    if (found?.id != null) {
      const value = String(found.id);
      if (sessionKey(currentId()) === key) likedPlaylistCache = { key, id: value };
      return value;
    }
    if (!j.more || !items.length) return "";
  }
  return "";
}

async function likedSnapshot(refresh) {
  const user = requireAccount();
  const key = sessionKey(user.id);
  const ttl = refresh ? LIKED_TTL : LIKED_PAGE_TTL;
  if (likedCache?.key === key && Date.now() - likedCache.fetchedAt < ttl) return likedCache;
  let entries = null;
  let known = new Map();
  const playlistId = await likedPlaylistId(user);
  if (playlistId) {
    const j = await api("/api/v6/playlist/detail", { id: id(playlistId), n: 1000, s: 0 });
    const p = j.playlist;
    if (p) {
      const privileges = new Map((j.privileges || []).map((x) => [String(x.id), x]));
      known = new Map((p.tracks || []).map((x) => [String(x.id), model.track(x, privileges.get(String(x.id)))]));
      if (Array.isArray(p.trackIds) && p.trackIds.length) {
        entries = p.trackIds.map((x) => ({ id: String(x.id), added: model.timestamp(x.at) }));
      } else if (known.size) {
        entries = [...known.keys()].map((trackId) => ({ id: trackId, added: "" }));
      } else if (!Number(p.trackCount)) {
        entries = [];
      }
    }
  }
  // 找不到红心歌单或详情缺少曲目编号时，回退到喜欢编号列表接口。
  if (!entries) {
    entries = (await likedIds()).map((trackId) => ({ id: trackId, added: "" }));
    known = new Map();
  }
  const snapshot = { key, fetchedAt: Date.now(), entries, known };
  if (sessionKey(currentId()) === key) likedCache = snapshot;
  return snapshot;
}

export async function liked({ offset = 0 }) {
  const start = offsetOf(offset);
  const snapshot = await likedSnapshot(start === 0);
  const slice = snapshot.entries.slice(start, start + PAGE);
  const missing = [...new Set(slice.map((x) => x.id).filter((x) => !snapshot.known.has(x)))];
  for (const track of await details(missing)) snapshot.known.set(track.id, track);
  return {
    tracks: slice.map(({ id: trackId, added }) => attachAdded(snapshot.known.get(trackId), added)),
    more: start + PAGE < snapshot.entries.length,
  };
}

export async function isLiked({ ids = [] }) {
  if (!hasSession()) return Object.fromEntries(ids.map((x) => [x, false]));
  const set = new Set(await likedIds());
  return Object.fromEntries(ids.map((x) => [x, set.has(String(x))]));
}

export async function like({ id: value, on }) {
  requireAccount();
  await api("/api/radio/like", { alg: "itembased", trackId: id(value), like: Boolean(on), time: "3" });
  likedCache = null;
  host.storage.remove("likedIds");
  host.storage.remove("likedAt");
}

// 心动模式：接着当前歌曲继续推荐。接口只认「我喜欢的音乐」歌单作为上下文，seed 是接着哪首放。
const HEARTBEAT = "heartbeat";

async function heartbeatSeed() {
  try {
    const [played] = await recent();
    if (played?.id) return String(played.id);
  } catch (e) {
    if (e.code === "signIn") throw e;
  }
  const [liked] = await likedIds();
  if (liked) return String(liked);
  fail("unavailable", "心动模式需要先收藏或播放一些歌曲");
}

export async function station({ id: value = "", seed = "" }) {
  if (String(value).split(":")[0] !== HEARTBEAT) fail("unsupported", "不支持这个电台");
  const user = requireAccount();
  const explicit = Boolean(seed);
  const start = seed ? id(seed) : await heartbeatSeed();
  const playlistId = await likedPlaylistId(user);
  if (!playlistId) fail("unavailable", "心动模式需要先收藏或播放一些歌曲");
  const j = await api("/api/playmode/intelligence/list", {
    songId: start, type: "fromPlayOne", playlistId, startMusicId: start, count: 100,
  });
  const seen = new Set([start]);
  const tracks = [];
  // 把 seed 放在队首：宿主换队列时看到队首就是正在播放的歌，会接着播完它（不重新加载），
  // 播完后自然进入推荐。续批时 seed 是队列最后一首，宿主追加时会按 key 去重。
  if (explicit) {
    try {
      const [lead] = await details([start]);
      if (lead && !lead.unavailable) tracks.push(lead);
    } catch (e) {
      if (e.code === "signIn") throw e;
    }
  }
  // 接口返回 { id, recommended, songInfo } 的列表；songInfo 是 v3 歌曲数据，去重并跳过 seed 本身。
  for (const item of j.data || []) {
    const song = item?.songInfo;
    if (!song?.id || seen.has(String(song.id))) continue;
    seen.add(String(song.id));
    tracks.push(model.track(song, song.privilege));
  }
  if (!tracks.length) fail("unavailable", "心动模式暂时没有可推荐的歌曲");
  return { tracks, more: true };
}

export async function savedAlbums({ offset = 0 }) {
  requireAccount();
  const j = await api("/api/album/sublist", { limit: PAGE, offset: offsetOf(offset), total: true });
  // 音乐库的原始数据读取路径要求数组；返回空数组时结束分页。
  return (j.data || []).map((x) => ({ ...model.album(x), saved: true }));
}

export async function saveAlbum({ id: value, on }) {
  requireAccount();
  await api(`/api/album/${on ? "sub" : "unsub"}`, { id: id(value) });
}

export async function recent() {
  requireAccount();
  const j = await api("/api/play-record/song/list", { limit: 50 });
  return (j.data?.list || []).filter((x) => x.data?.id).map((x) => model.track(x.data));
}

export async function home() {
  const j = await api("/api/personalized/playlist", { limit: 24, total: true, n: 1000 });
  const sections = [];
  let featured = 0;
  if (hasSession()) {
    // 宿主把前两个 Mode 画成大卡、第三个起画成小行。小行一行放 3 个，所以这里排成
    // 「心动模式 / 我喜欢的音乐 / 最近播放」正好填满一行；前两张大卡用每日推荐和推荐歌单填。
    const extra = [];
    const account = host.storage.get("account");
    if (account?.id) {
      try {
        const listId = await likedPlaylistId(account);
        if (listId) {
          let cover = "";
          try { cover = await likedCover(listId); } catch (_) { /* 封面拿不到就留空 */ }
          extra.push({ title: t("我喜欢的音乐"), subtitle: t("从你收藏的歌曲继续"), playlist: listId, imageUrl: cover });
        }
      } catch (_) { /* 取不到就不放这一行 */ }
    }
    try {
      const tracks = (await recent()).slice(0, 50);
      if (tracks.length) extra.push({ title: t("最近播放"), subtitle: t("接着上次的收听"), tracks });
    } catch (_) { /* 最近播放取不到就不放这一行 */ }

    const heroes = [];
    let daily = false;
    try {
      const d = await api("/api/v3/discovery/recommend/songs", {});
      const tracks = (d.data?.dailySongs || []).map((x) => model.track(x));
      if (tracks.length) {
        heroes.push({ title: t("每日推荐"), subtitle: t("根据你的听歌喜好更新"), tracks });
        daily = true;
      }
    } catch (e) {
      if (e.code === "signIn") throw e;
    }
    const playlists = (j.result || []).map((x) => model.playlist(x, currentId()));
    while (heroes.length < 2 && featured < playlists.length) {
      const p = playlists[featured++];
      heroes.push({ title: p.name, subtitle: p.owner, playlist: p.id, imageUrl: p.imageUrl });
    }
    while (heroes.length < 2 && extra.length) heroes.push(extra.shift());
    sections.push({ style: "modes", modes: [...heroes, { title: t("心动模式"), subtitle: t("接着当前歌曲继续推荐"), station: HEARTBEAT }, ...extra] });
    if (!daily) sections.push({ title: t("每日推荐"), links: [{ title: t("每日推荐歌曲"), page: "daily", subtitle: t("根据你的听歌喜好更新") }] });
    sections.push({ title: t("推荐歌单"), style: "shelf", playlists: (j.result || []).slice(featured).map((x) => model.playlist(x, currentId())) });
  } else {
    sections.push({ title: t("推荐歌单"), style: "shelf", playlists: (j.result || []).map((x) => model.playlist(x, currentId())) });
  }
  sections.push({ title: t("发现音乐"), links: [{ title: t("排行榜"), page: "charts" }, { title: t("最新专辑"), page: "new-albums" }, { title: t("热门歌单"), page: "playlists:全部:0" }] });
  return { title: t("网易云音乐"), sections };
}

export async function browse({ page = "" }) {
  if (page === "cloud" || page.startsWith("cloud:")) {
    requireAccount();
    const rawOffset = page === "cloud" ? "0" : page.slice(6);
    if (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset))) fail("unsupported", "不支持这个发现页面");
    const offset = Number(rawOffset);
    const j = await api("/api/v1/cloud/get", { limit: PAGE, offset });
    if (!Array.isArray(j.data)) fail("failed", "网易云返回了无法识别的响应，请稍后重试");
    const next = offset + j.data.length;
    const more = j.data.length > 0 && (j.hasMore == null ? Number(j.count) > next : j.hasMore === true || j.hasMore === 1);
    const sections = [{ title: t("我的云盘"), tracks: j.data.map((x) => model.cloudTrack(x)), empty: t("云盘中还没有歌曲") }];
    const links = [];
    if (offset > 0) links.push({ title: t("上一页"), page: `cloud:${Math.max(0, offset - PAGE)}` });
    if (more) links.push({ title: t("下一页"), page: `cloud:${next}` });
    if (links.length) sections.push({ links });
    return {
      title: t("我的云盘"), sections,
      tabs: [{ title: t("热门歌单"), page: "" }, { title: t("我的云盘"), page: "cloud", selected: true }],
      // 新版宿主的发现页通过 filters 翻页，保留 links 兼容旧版页面。
      filters: links.length ? [links] : [],
    };
  }
  if (page === "daily") {
    requireAccount();
    const j = await api("/api/v3/discovery/recommend/songs", {});
    return { title: t("每日推荐歌曲"), sections: [{ tracks: (j.data?.dailySongs || []).map((x) => model.track(x)) }] };
  }
  if (page === "charts") {
    const j = await api("/api/toplist");
    return { title: t("排行榜"), sections: [{ style: "grid", playlists: (j.list || []).map((x) => model.playlist(x, currentId())) }] };
  }
  if (page === "new-albums") {
    const j = await api("/api/discovery/newAlbum");
    return { title: t("最新专辑"), sections: [{ style: "grid", albums: (j.albums || []).map(model.album) }] };
  }
  const [prefix, category = "全部", offset = "0"] = page.split(":");
  if (page && prefix !== "playlists") fail("unsupported", "不支持这个发现页面");
  const start = offsetOf(offset);
  const j = await api("/api/playlist/list", { cat: category, order: "hot", limit: 30, offset: start, total: true });
  const sections = [{ style: "grid", playlists: (j.playlists || []).map((x) => model.playlist(x, currentId())) }];
  if (j.more) sections.push({ links: [{ title: t("下一页"), page: `playlists:${category}:${start + 30}` }] });
  return {
    title: t("热门歌单"), sections,
    tabs: [...["全部", "华语", "欧美", "日语", "韩语", "轻音乐", "古典", "电子"].map((title) => ({ title: t(title), page: `playlists:${title}:0`, selected: title === category })), { title: t("我的云盘"), page: "cloud" }],
  };
}

export async function stream({ id: value, quality = "high" }) {
  const levels = { hires: "hires", lossless: "lossless", high: "exhigh", standard: "standard" };
  const order = Object.keys(levels);
  const setting = typeof host.setting === "function" ? host.setting("quality") : "";
  // 插件设置优先于宿主的默认档位；空设置保留原来的跟随行为。
  const selected = order.includes(setting) ? setting : order.includes(quality) ? quality : "high";
  const songId = id(value);
  for (const candidate of order.slice(order.indexOf(selected))) {
    const level = levels[candidate];
    const j = await api("/api/song/enhance/player/url/v1", { ids: JSON.stringify([songId]), level, encodeType: "flac" });
    const s = j.data?.[0];
    // 无完整音频时只向下尝试；登录失效、网络和验证错误由 api 原样报告。
    if (!s?.url || (s.freeTrialInfo && s.freeTrialInfo !== "null")) continue;
    if (!/^https?:\/\//i.test(s.url)) fail("unavailable", "网易云未返回有效的音频地址");
    return { url: s.url.replace(/^http:\/\//i, "https://"), type: s.type || "mp3", quality: s.level || level, bitRate: s.br || 0, size: s.size || 0 };
  }
  fail("unavailable", hasSession() ? "此歌曲需要会员、单独购买，或当前地区无版权；不会以试听片段代替完整歌曲" : "此歌曲需要登录或相应会员权限，请先扫码登录网易云音乐");
}

export async function lyrics({ id: value }) {
  const j = await api("/api/song/lyric", { id: id(value), tv: -1, lv: -1, rv: -1, kv: -1, _nmclfl: 1 });
  return { lrc: j.lrc?.lyric || "", translation: j.tlyric?.lyric || "" };
}

export function trackMenu() {
  return [
    { id: "heartbeat", title: t("从这里开始心动模式") },
    { id: "open-netease", title: t("在网易云音乐网页打开") },
  ];
}

export function menuAction({ id: action, track }) {
  if (action === "heartbeat") return { station: { id: HEARTBEAT, seed: id(track?.id) } };
  if (action !== "open-netease") fail("unsupported", "未知菜单操作");
  host.openURL(`https://music.163.com/song?id=${id(track.id)}`);
  return {};
}
