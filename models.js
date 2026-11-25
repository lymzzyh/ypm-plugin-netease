import { t } from "./i18n.js";

const sid = (x) => x == null ? "" : String(x);
const image = (x) => String(x || "").replace(/^http:\/\//, "https://");
const date = (x) => x > 0 ? new Date(x).toISOString().slice(0, 10) : "";

export function timestamp(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function artist(x = {}) {
  return { id: sid(x.id), name: x.name || t("未知歌手"), imageUrl: image(x.picUrl || x.img1v1Url) };
}

export function album(x = {}) {
  const artists = x.artists || (x.artist ? [x.artist] : []);
  const type = String(x.type || "").toLowerCase();
  return {
    id: sid(x.id), name: x.name || t("未知专辑"), imageUrl: image(x.picUrl || x.blurPicUrl),
    artists: artists.map(artist), trackCount: x.size ?? x.songCount ?? 0,
    released: date(x.publishTime), copyright: x.copyright || "",
    kind: type.includes("single") ? "single" : type === "ep" ? "ep" : "album",
  };
}

export function track(x = {}, privilege = {}) {
  return {
    id: sid(x.id), name: x.name || t("未知歌曲"), artists: (x.ar || x.artists || []).map(artist),
    album: album(x.al || x.album || {}), duration: x.dt ?? x.duration ?? 0,
    url: `https://music.163.com/song?id=${sid(x.id)}`,
    unavailable: Number(privilege.st ?? x.privilege?.st ?? 0) < 0 || Boolean(x.noCopyrightRcmd),
  };
}

export function playlist(x = {}, userId = "") {
  const mine = Boolean(userId) && sid(x.creator?.userId || x.userId) === userId;
  return {
    id: sid(x.id), name: x.name || t("未命名歌单"), imageUrl: image(x.coverImgUrl || x.picUrl),
    description: x.description || "", owner: x.creator?.nickname || "",
    trackCount: x.trackCount ?? x.tracks?.length ?? 0,
    plays: x.playCount || 0, mine, saved: Boolean(x.subscribed),
    fixed: mine && x.specialType === 5,
  };
}

export function cloudTrack(x = {}) {
  const song = x.simpleSong && typeof x.simpleSong === "object" ? x.simpleSong : {};
  // 云盘编号可能不同于匹配到的公共曲库编号，播放必须保留上传记录的 songId。
  const songId = [x.songId, song.id].map(sid).find((value) => /^\d+$/.test(value) && !/^0+$/.test(value)) || "";
  const mapped = track({
    ...song, id: songId, name: x.songName || song.name || x.fileName,
    ar: song.ar?.length ? song.ar : song.artists?.length ? song.artists : [{ name: x.artist || t("未知歌手") }],
    al: { ...(song.al || song.album || {}), name: x.album || song.al?.name || song.album?.name || t("未知专辑"), picUrl: x.cover || song.al?.picUrl || song.album?.picUrl },
  });
  // 公共曲库下架不代表用户自己的云盘文件不可播，授权由取播放地址的接口确认。
  return { ...mapped, unavailable: !songId };
}
