'use strict';
// 词语领地服务器：HTTP 静态文件 + WebSocket 实时同步 + 磁盘持久化。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const game = require('./game');
const seasonLib = require('./season');
const sharesLib = require('./public/shares');
const plazaLib = require('./public/plaza');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
// 测试可用 WT_DATA_FILE 指定独立存档，避免污染开发用的 data/rooms.json
const DATA_FILE = process.env.WT_DATA_FILE
  ? path.resolve(process.env.WT_DATA_FILE)
  : path.join(DATA_DIR, 'rooms.json');
// 赛季战绩单独落盘（与房间存档解耦）；测试可用 WT_SEASON_FILE 指向临时文件
const SEASON_FILE = process.env.WT_SEASON_FILE
  ? path.resolve(process.env.WT_SEASON_FILE)
  : path.join(DATA_DIR, 'season.json');
// 词包分享码单独落盘：{ [分享码]: { code,pid,packId,pack 快照,updatedAt } }。
// 与房间/赛季解耦——分享不依赖任何对局存在，作者取消后码立即作废；
// 测试可用 WT_SHARES_FILE 指向临时文件。
const SHARES_FILE = process.env.WT_SHARES_FILE
  ? path.resolve(process.env.WT_SHARES_FILE)
  : path.join(DATA_DIR, 'shares.json');
// 交流广场单独落盘：{ [广场id]: { id,pid,packId,author,pack 快照,subs,publishedAt,updatedAt } }。
// 与房间/赛季/分享码解耦——广场条目不依赖任何对局存在，作者下架后立即从广场消失；
// 测试可用 WT_PLAZA_FILE 指向临时文件。
const PLAZA_FILE = process.env.WT_PLAZA_FILE
  ? path.resolve(process.env.WT_PLAZA_FILE)
  : path.join(DATA_DIR, 'plaza.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 赛季战绩存储 ----------

let season = seasonLib.emptySeason();
// 加载的赛季档案是否为没有逐局索引的旧版（v1）。旧档里的结束房视为"早已计入"，
// 只用于加载时给房间补标记；新产生的对局一律以索引为准。
let seasonLegacy = true;

function loadSeason() {
  try {
    const { season: loaded, legacy } = seasonLib.normalizeSeason(
      JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')));
    season = loaded;
    seasonLegacy = legacy;
    console.log(`已恢复赛季战绩：${Object.keys(season.players).length} 名玩家`);
  } catch { /* 首次启动或数据损坏，从空赛季开始（此时没有任何"已计入"的旧局） */
    seasonLegacy = false;
  }
}

let seasonSaveTimer = null;
function saveSeason() {
  clearTimeout(seasonSaveTimer);
  seasonSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(SEASON_FILE), { recursive: true });
      fs.writeFileSync(SEASON_FILE, JSON.stringify(season));
    } catch (e) { console.error('赛季战绩保存失败', e); }
  }, 300);
}

// 立即落盘（停服前调用，避免防抖未落盘丢失最后一局的战绩）
function flushSeason() {
  clearTimeout(seasonSaveTimer);
  try {
    fs.mkdirSync(path.dirname(SEASON_FILE), { recursive: true });
    fs.writeFileSync(SEASON_FILE, JSON.stringify(season));
  } catch (e) { console.error('赛季战绩保存失败', e); }
}

// ---------- 词包分享码存储 ----------
// 分享与房间/赛季完全解耦：作者把本机词包快照发布到这里拿到 8 位码，
// 朋友凭码导入；作者（同一 pidSecret 派生出的 pid）可取消，码立即作废。
let shareStore = sharesLib.emptyShares();

function loadShares() {
  try {
    shareStore = sharesLib.normalizeShares(
      JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')));
    console.log(`已恢复词包分享：${Object.keys(shareStore.shares).length} 个分享码`);
  } catch { /* 首次启动或数据损坏，从空表开始 */ }
}

let sharesSaveTimer = null;
function saveShares() {
  clearTimeout(sharesSaveTimer);
  sharesSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(SHARES_FILE), { recursive: true });
      fs.writeFileSync(SHARES_FILE, JSON.stringify(shareStore));
    } catch (e) { console.error('词包分享保存失败', e); }
  }, 300);
}

// 停服前立即落盘（与赛季一致，避免最后一个分享还在防抖队列里）
function flushShares() {
  clearTimeout(sharesSaveTimer);
  try {
    fs.mkdirSync(path.dirname(SHARES_FILE), { recursive: true });
    fs.writeFileSync(SHARES_FILE, JSON.stringify(shareStore));
  } catch (e) { console.error('词包分享保存失败', e); }
}

// ---------- 交流广场存储 ----------
// 广场与房间/赛季/分享码完全解耦：作者把本机词包快照发布到这里，
// 任何人浏览/搜索/订阅；作者（同一 pidSecret 派生出的 pid）可随时下架。
let plazaStore = plazaLib.emptyPlaza();

function loadPlaza() {
  try {
    plazaStore = plazaLib.normalizePlaza(
      JSON.parse(fs.readFileSync(PLAZA_FILE, 'utf8')));
    console.log(`已恢复交流广场：${Object.keys(plazaStore.packs).length} 个词包`);
  } catch { /* 首次启动或数据损坏，从空广场开始 */ }
}

let plazaSaveTimer = null;
function savePlaza() {
  clearTimeout(plazaSaveTimer);
  plazaSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(PLAZA_FILE), { recursive: true });
      fs.writeFileSync(PLAZA_FILE, JSON.stringify(plazaStore));
    } catch (e) { console.error('交流广场保存失败', e); }
  }, 300);
}

// 停服前立即落盘（避免最后一次发布/订阅还在防抖队列里）
function flushPlaza() {
  clearTimeout(plazaSaveTimer);
  try {
    fs.mkdirSync(path.dirname(PLAZA_FILE), { recursive: true });
    fs.writeFileSync(PLAZA_FILE, JSON.stringify(plazaStore));
  } catch (e) { console.error('交流广场保存失败', e); }
}

// ---------- 房间存储 ----------

/** rooms: Map<code, room>; tokens: Map<token, {roomCode, playerId, spectator?}> */
const rooms = new Map();
const tokens = new Map();
/** sockets: Map<playerId, Set<ws>>（玩家与观战者共用，id 不冲突：观战者带 sp_ 前缀） */
const sockets = new Map();
/** 观战者断线宽限期：id -> setTimeout，超过后从房间清出（覆盖刷新页面的短暂离线） */
const spectatorPruneTimers = new Map();
const SPECTATOR_TTL_MS = Number(process.env.SPECTATOR_TTL_MS) || 60 * 1000;
// 已结束房间保留期：结束超过此时长的房间连同整份回放日志一并删除，对应 token 全部作废。
// 赛季战绩在对局结束时已单独累计进 season.json，删房不影响排行榜与个人页。
const ROOM_RETENTION_MS = Number(process.env.WT_ROOM_TTL_MS) || 7 * 24 * 60 * 60 * 1000;
// 保留期清理的周期检查间隔（长期不重启也能自动收敛存档）
const ROOM_PRUNE_INTERVAL_MS = Number(process.env.WT_ROOM_PRUNE_INTERVAL_MS) || 60 * 60 * 1000;

function loadRooms() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const loadedRoomCodes = new Set();
    for (const room of raw.rooms) {
      // 旧存档没有 id 字段：补一个稳定唯一 id 并随下次落盘固化（赛季逐局去重要用）
      game.ensureRoomId(room);
      // 旧存档没有 spectators 字段时补空
      if (!Array.isArray(room.spectators)) room.spectators = [];
      // 旧存档没有主题词包字段：补 null（使用默认词池）
      if (!('wordPack' in room)) room.wordPack = null;
      // 重启后不存在任何活动连接。玩家保留座位、置离线，凭 token 重连恢复；
      // 观战者是临时只读身份，立即清出——不能让他们在大厅/对局名单里挂到延迟清理才消失，
      // 也不能虚占在线名额让新观战者撞上"已满"。想继续看的人重新输入房间码即可。
      game.resetConnectionsAfterRestart(room);
      game.removeAllSpectators(room);
      // 赛季是否已计入，只认赛季档案自己的逐局索引：
      //  - 索引里有：说明玩家汇总确实已落盘，补上内存标记，重连结算房时不重复累计；
      //  - 索引里没有：这局可能是"内存计过但赛季没落盘"（如防抖窗口内被杀），
      //    绝不补标记——保留期清理会在删房前把它补记回赛季。
      // 旧版（v1）赛季档没有索引：加载后统一对账（见下方 legacy 对账），对账前先按索引标。
      if (room.phase === 'ended') room.seasonRecorded = seasonLib.isRoomRecorded(season, room);
      rooms.set(room.code, room);
      loadedRoomCodes.add(room.code);
      // 重启后回合计时重新挂上
      if (room.phase === 'playing' && room.turn) {
        if (room.turn.deadline) {
          room.turn.deadline = Date.now() + room.ruleSet.turnSeconds * 1000;
        } else if (room.turn.pausedRemaining == null) {
          room.turn.deadline = Date.now() + room.ruleSet.turnSeconds * 1000;
        }
        scheduleTurnTimer(room);
      }
    }
    // 只恢复玩家 token；旧观战身份已随重启作废，其 token 一并丢弃，避免残留膨胀
    for (const [token, ref] of Object.entries(raw.tokens || {})) {
      if (ref && !ref.spectator && loadedRoomCodes.has(ref.roomCode)) tokens.set(token, ref);
    }
    // 旧版（v1）赛季档没有逐局索引：把现存所有结束房只登记进索引、不重算战绩
    // （它们的玩家汇总早已在档案里）。登记后 v1 与 v2 统一"只认索引"，否则一旦有
    // 新对局触发赛季写盘，旧局会在索引里缺失，清理时被当成漏记局而重复累计一遍。
    if (seasonLegacy) {
      let dirty = false;
      for (const room of rooms.values()) {
        if (room.phase === 'ended' && seasonLib.markRoomRecorded(season, room)) dirty = true;
      }
      if (dirty) flushSeason();
      seasonLegacy = false; // 进程此后只认索引
    }
    // 启动即清一次超期的已结束房间（连同 token 与回放日志），旧存档里的积压在这一步收敛。
    // 清理对"索引里没有"的局会先补记战绩并同步落盘赛季，再删房间。
    const expired = pruneExpiredRooms();
    if (raw.rooms.length || expired.length) saveRooms(); // 落盘清出观战者/删除超期房后的干净状态
    console.log(`已恢复 ${rooms.size} 个房间`);
  } catch { /* 首次启动或数据损坏，忽略 */ }
}

let saveTimer = null;
function saveRooms() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      // 结束的房间只保留回放/结算所需的玩家与日志，不持久化观战者；
      // 观战是临时身份，重启后本就不可恢复，避免旧观战记录残留在线名单。
      const persistedRooms = [...rooms.values()].map(r =>
        r.phase === 'ended' ? { ...r, spectators: [] } : r);
      const liveCodes = new Set(persistedRooms.map(r => r.code));
      const persistedTokens = {};
      for (const [tok, ref] of tokens) {
        if (!liveCodes.has(ref.roomCode)) continue;
        if (ref.spectator && rooms.get(ref.roomCode).phase === 'ended') continue;
        persistedTokens[tok] = ref;
      }
      fs.writeFileSync(DATA_FILE, JSON.stringify({
        rooms: persistedRooms, tokens: persistedTokens,
      }));
    } catch (e) { console.error('保存失败', e); }
  }, 300);
}

// ---------- 已结束房间保留期清理 ----------

// 删除超期房间：房间记录、整份回放日志与该房全部 token 一并清掉。
// 首页历史是客户端持 token 换摘要：token 失效后对应条目会按现有机制自动消失。
//
// 关键安全约束：房间上的 seasonRecorded 标记不能作为"已计入赛季"的凭据——对局结束时
// 赛季文件是 300ms 防抖落盘的，若进程在落盘前退出/写盘失败，标记会随房间存档残留为真，
// 但赛季文件里根本没有这局。因此删房前必须查赛季档案自己的逐局索引；没查到就先补记，
// 并且把赛季文件同步刷到磁盘后再删房间，保证"房间消失"时战绩一定已经独立留存。
function pruneExpiredRooms(now = Date.now()) {
  if (!(ROOM_RETENTION_MS > 0)) return [];
  const candidates = [];
  for (const room of rooms.values()) {
    if (!game.isRoomExpired(room, ROOM_RETENTION_MS, now)) continue;
    // 正有人连着看结算/回放的房间先留着，等下一个周期连接都断开后再清
    const hasConnection = room.players.some(p => p.connected) ||
      (room.spectators || []).some(s => s.connected);
    if (hasConnection) continue;
    candidates.push(room);
  }
  if (!candidates.length) return [];

  // 先处理赛季：索引里没有的局补记一次（recordRoom 按索引幂等，标记残留也不影响）。
  // flush 必须在删除房间之前同步完成，否则进程恰好在两步之间退出就会重演丢战绩。
  let seasonDirty = false;
  for (const room of candidates) {
    if (!seasonLib.isRoomRecorded(season, room)) {
      const { changed } = seasonLib.recordRoom(season, room, now);
      if (changed) seasonDirty = true;
    }
    // 观战清理定时器只可能指向非结束房，这里顺手停掉以防残留句柄
    for (const s of room.spectators || []) {
      const t = spectatorPruneTimers.get(s.id);
      if (t) { clearTimeout(t); spectatorPruneTimers.delete(s.id); }
    }
  }
  if (seasonDirty) flushSeason();

  const removed = [];
  for (const room of candidates) {
    rooms.delete(room.code);
    for (const [tok, ref] of tokens) {
      if (ref.roomCode === room.code) tokens.delete(tok);
    }
    removed.push(room);
  }
  saveRooms();
  const span = ROOM_RETENTION_MS >= 86400000
    ? `${Math.round(ROOM_RETENTION_MS / 86400000)} 天`
    : ROOM_RETENTION_MS >= 3600000
      ? `${Math.round(ROOM_RETENTION_MS / 3600000)} 小时`
      : `${Math.round(ROOM_RETENTION_MS / 60000)} 分钟`;
  console.log(`已清理 ${removed.length} 个超过保留期（${span}）的已结束房间`);
  return removed;
}

let roomPruneTimer = null;
function scheduleRoomPruning() {
  if (!(ROOM_PRUNE_INTERVAL_MS > 0)) return;
  roomPruneTimer = setInterval(() => pruneExpiredRooms(), ROOM_PRUNE_INTERVAL_MS);
  roomPruneTimer.unref?.(); // 测试/短进程中定时器不挂住退出
}

// ---------- 广播 ----------

function broadcast(room) {
  // 对局首次结束：为每名可识别玩家（带跨对局稳定 pid）累计一条公开赛季战绩。
  // 进程内用 seasonRecorded 做快速短路；真正的幂等凭据是赛季档案的逐局索引——
  // 重连/重启后房间标记可能残留，但 recordRoom 内部只认索引，重复广播不会重复累计。
  if (room.phase === 'ended' && !room.seasonRecorded) {
    const { changed } = seasonLib.recordRoom(season, room);
    if (changed) saveSeason();
  }
  const recipients = [
    ...room.players.map(p => p.id),
    ...(room.spectators || []).map(s => s.id),
  ];
  for (const id of recipients) {
    const set = sockets.get(id);
    if (!set) continue;
    const view = JSON.stringify({ type: 'state', state: game.publicView(room, id) });
    for (const ws of set) if (ws.readyState === 1) ws.send(view);
  }
  saveRooms();
}

function sendTo(playerId, msg) {
  const set = sockets.get(playerId);
  if (!set) return;
  const s = JSON.stringify(msg);
  for (const ws of set) if (ws.readyState === 1) ws.send(s);
}

// ---------- 回合计时 ----------

const turnTimers = new Map();
function scheduleTurnTimer(room) {
  clearTimeout(turnTimers.get(room.code));
  if (room.phase !== 'playing' || !room.turn || !room.turn.deadline) return;
  const delay = Math.max(0, room.turn.deadline - Date.now());
  turnTimers.set(room.code, setTimeout(() => {
    if (room.phase !== 'playing' || !room.turn) return;
    const err = game.endTurn(room, room.turn.playerId, { auto: true });
    if (!err) { scheduleTurnTimer(room); broadcast(room); }
  }, delay + 50));
}

// ---------- 消息处理 ----------

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// 词包分享码：8 位、与房间码同一套易读字母表（不含 0/1/I/O），不绑房间；
// 撞码由 sharesLib.publishForPack 检测后重试，这里只负责随机产出候选码。
function makeShareCode() {
  const { CODE_LEN, CODE_ALPHABET } = sharesLib;
  return Array.from({ length: CODE_LEN },
    () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
}

// 广场条目 id：pz_ + 12 位十六进制，撞 id 由 plazaLib.publish 检测后重试
function makePlazaId() {
  return `pz_${crypto.randomBytes(6).toString('hex')}`;
}

function issueToken(roomCode, playerId, spectator = false) {
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { roomCode, playerId, spectator });
  return token;
}

function attachSocket(playerId, ws) {
  if (!sockets.has(playerId)) sockets.set(playerId, new Set());
  sockets.get(playerId).add(ws);
}

function cancelSpectatorPrune(spectatorId) {
  const t = spectatorPruneTimers.get(spectatorId);
  if (t) { clearTimeout(t); spectatorPruneTimers.delete(spectatorId); }
}

// 观战者最后一个连接断开：标记离线并给一个宽限期，超时再清出房间
// （页面刷新/短暂断网时 token 仍可恢复观战身份）
function scheduleSpectatorPrune(spectatorId) {
  cancelSpectatorPrune(spectatorId);
  spectatorPruneTimers.set(spectatorId, setTimeout(() => {
    spectatorPruneTimers.delete(spectatorId);
    for (const room of rooms.values()) {
      const s = (room.spectators || []).find(x => x.id === spectatorId);
      if (!s || sockets.has(spectatorId)) continue;
      game.removeSpectator(room, spectatorId);
      broadcast(room); // 让其他人名单中的旧观战者消失
    }
    // 清掉失效的观战 token，避免 token 表无限增长
    for (const [tok, ref] of tokens) {
      if (ref.spectator && ref.playerId === spectatorId) tokens.delete(tok);
    }
  }, SPECTATOR_TTL_MS));
}

function detachSocket(playerId, ws) {
  const set = sockets.get(playerId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    sockets.delete(playerId);
    for (const room of rooms.values()) {
      // 观战者：走离线宽限，不触发玩家断线/裁定移交逻辑
      const sp = (room.spectators || []).find(x => x.id === playerId);
      if (sp) {
        if (sp.connected) {
          sp.connected = false;
          broadcast(room);
        }
        scheduleSpectatorPrune(playerId);
        continue;
      }
      const p = room.players.find(x => x.id === playerId);
      if (p && p.connected) {
        p.connected = false;
        game.ensureAdjudicatorOnline(room);
        broadcast(room);
      }
    }
  }
}

const handlers = {
  createRoom(ws, ctx, msg) {
    const code = makeRoomCode();
    const playerId = crypto.randomBytes(8).toString('hex');
    // 公开 pid 只能由服务端从玩家密钥派生，绝不采信客户端自报的 pid（否则可冒用他人身份）
    const { pid } = seasonLib.resolvePid(msg);
    const room = game.newRoom(code, playerId, msg.name);
    game.addPlayer(room, playerId, msg.name, pid);
    if (msg.ruleSet) game.setRuleSet(room, playerId, msg.ruleSet);
    rooms.set(code, room);
    const token = issueToken(code, playerId);
    ctx.playerId = playerId; ctx.roomCode = code;
    attachSocket(playerId, ws);
    ws.send(JSON.stringify({ type: 'joined', token, roomCode: code, playerId }));
    broadcast(room);
  },

  joinRoom(ws, ctx, msg) {
    const room = rooms.get(String(msg.roomCode || '').toUpperCase());
    if (!room) return sendErr(ws, '房间不存在，请检查房间码');
    const playerId = crypto.randomBytes(8).toString('hex');
    const { pid } = seasonLib.resolvePid(msg);
    const err = game.addPlayer(room, playerId, msg.name, pid);
    if (err) return sendErr(ws, err);
    const token = issueToken(room.code, playerId);
    ctx.playerId = playerId; ctx.roomCode = room.code;
    attachSocket(playerId, ws);
    ws.send(JSON.stringify({ type: 'joined', token, roomCode: room.code, playerId }));
    broadcast(room);
  },

  // 观战：凭房间码获得只读身份，任何阶段都可进入（大厅可看规则/玩家，对局中持续收推送）
  spectate(ws, ctx, msg) {
    const room = rooms.get(String(msg.roomCode || '').toUpperCase());
    if (!room) return sendErr(ws, '房间不存在，请检查房间码');
    const spectatorId = 'sp_' + crypto.randomBytes(8).toString('hex');
    const err = game.addSpectator(room, spectatorId, msg.name);
    if (err) return sendErr(ws, err);
    const token = issueToken(room.code, spectatorId, true);
    ctx.playerId = spectatorId; ctx.roomCode = room.code;
    attachSocket(spectatorId, ws);
    ws.send(JSON.stringify({ type: 'joined', token, roomCode: room.code,
      playerId: spectatorId, spectator: true }));
    broadcast(room);
  },

  // 断线重连：凭 token 恢复身份（玩家或观战者）。
  // 所有无法恢复的拒绝都带 context:'reconnect'，客户端据此停止自动恢复流程，
  // 展示"返回首页 / 重新输入房间码"入口，而不是无限重连或只弹一个会消失的 toast。
  reconnect(ws, ctx, msg) {
    const ref = tokens.get(msg.token);
    if (!ref) return sendErr(ws, '会话已失效，请重新加入', 'reconnect');
    const room = rooms.get(ref.roomCode);
    if (!room) return sendErr(ws, '房间已不存在', 'reconnect');
    if (ref.spectator) {
      const s = (room.spectators || []).find(x => x.id === ref.playerId);
      if (!s) return sendErr(ws, '观战会话已失效，请重新观战', 'reconnect');
      // 观战是临时只读会话：对局结束后不再凭 token 恢复。刷新页面应回到首页，
      // 想看结算/回放可重新输入房间码进入。移除记录并作废 token，避免旧会话残留。
      if (room.phase === 'ended') {
        cancelSpectatorPrune(s.id);
        game.removeSpectator(room, s.id);
        for (const [tok, r] of tokens) {
          if (r.spectator && r.playerId === s.id) tokens.delete(tok);
        }
        broadcast(room);
        return sendErr(ws, '对局已结束，观战会话已失效，请重新输入房间码观战', 'reconnect');
      }
      s.connected = true;
      cancelSpectatorPrune(s.id);
      ctx.playerId = s.id; ctx.roomCode = room.code;
      attachSocket(s.id, ws);
      ws.send(JSON.stringify({ type: 'joined', token: msg.token,
        roomCode: room.code, playerId: s.id, spectator: true }));
      broadcast(room);
      return;
    }
    const p = room.players.find(x => x.id === ref.playerId);
    if (!p) return sendErr(ws, '你不在该房间中', 'reconnect');
    p.connected = true;
    ctx.playerId = ref.playerId; ctx.roomCode = room.code;
    attachSocket(ref.playerId, ws);
    ws.send(JSON.stringify({ type: 'joined', token: msg.token,
      roomCode: room.code, playerId: ref.playerId }));
    broadcast(room);
  },

  // 重连成功后客户端显式拉取一次房间最新状态：断线期间可能错过多次广播，
  // 以这次同步作为"恢复完成"的确认信号，客户端收到后重新渲染并解除操作禁用。
  syncState(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return sendErr(ws, '房间已不存在', 'reconnect');
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'state', state: game.publicView(room, ctx.playerId) }));
    }
  },

  setRules(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    // 客户端会等待明确答复后才解除提交锁定，任何情况都要给出回应
    if (!room) return sendErr(ws, '房间已不存在', 'setRules');
    const err = game.setRuleSet(room, ctx.playerId, msg.ruleSet || {});
    if (err) return sendErr(ws, err, 'setRules');
    // 明确告知保存方成功，客户端据此关闭编辑器并给出反馈
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'rulesSaved' }));
    broadcast(room);
  },

  // 主题词包：房主在大厅选用本机词包（内容作为快照进入房间状态，全员可见）；
  // 失败带上下文，客户端据此在词包选择处就地提示。
  setWordPack(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return sendErr(ws, '房间已不存在', 'setWordPack');
    const err = game.setWordPack(room, ctx.playerId, msg.pack ?? null);
    if (err) return sendErr(ws, err, 'setWordPack');
    broadcast(room);
  },

  // 词包分享：作者把本机词包快照存到服务端并拿到 8 位分享码（同一词包重复点分享沿用原码、
  // 更新快照）。身份与赛季同一道凭据：只认密钥派生出的 pid，取消分享时据此确认是作者本人。
  sharePack(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    if (!pid) return sendErr(ws, '需要有效的本机身份才能分享词包', 'sharePack');
    const cleaned = game.sanitizeWordPack(msg.pack);
    if (typeof cleaned === 'string') return sendErr(ws, cleaned, 'sharePack');
    const result = sharesLib.publishForPack(shareStore, {
      pid, packId: cleaned.id, pack: cleaned, generate: makeShareCode,
    });
    if (result.error) return sendErr(ws, result.error, 'sharePack');
    saveShares();
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'shared', code: result.code, packId: cleaned.id,
        name: cleaned.name, updatedAt: result.updatedAt, republished: result.updated,
      }));
    }
  },

  // 取消分享：只有码的作者（同一 pid）能作废；成功后码立即失效，朋友凭旧码无法再导入。
  unsharePack(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    if (!pid) return sendErr(ws, '需要有效的本机身份才能取消分享', 'unsharePack');
    const ok = sharesLib.unpublish(shareStore, msg.code, pid);
    if (!ok) return sendErr(ws, '分享码无效，或你不是这个分享的作者', 'unsharePack');
    saveShares();
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'unshared', code: sharesLib.normalizeCode(msg.code) }));
    }
  },

  // 朋友凭码导入：只读公开端点，无需加入任何房间；返回的词包不带作者信息、
  // 带服务端原始 packId，客户端据此生成本机副本并去重。
  importShare(ws, ctx, msg) {
    const code = sharesLib.normalizeCode(msg.code);
    if (!sharesLib.isValidCode(code)) {
      return sendErr(ws, '分享码应为 8 位字母数字，请检查后重试', 'importShare');
    }
    const entry = sharesLib.getShare(shareStore, code);
    if (!entry) return sendErr(ws, '分享码无效或已被作者取消', 'importShare');
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'sharedPack', code,
        pack: { id: entry.packId, ...entry.pack } }));
    }
  },

  // 我的分享列表（本机身份下全部有效码）：客户端进入「我的词包」时拉取并与本机映射对账，
  // 跨设备分享的词包也能看到/取消；服务端已取消的码不返回，客户端据此清掉本机残留。
  myShares(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'myShares', shares: pid ? sharesLib.listByOwner(shareStore, pid) : [] }));
    }
  },

  // ---------- 交流广场 ----------

  // 发布到广场：作者把本机词包快照公开到广场（同一词包重复发布沿用原条目、更新快照，
  // 订阅数保留）。身份与赛季/分享同一道凭据：只认密钥派生出的 pid。
  plazaPublish(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    if (!pid) return sendErr(ws, '需要有效的本机身份才能发布到广场', 'plazaPublish');
    const cleaned = game.sanitizeWordPack(msg.pack);
    if (typeof cleaned === 'string') return sendErr(ws, cleaned, 'plazaPublish');
    const result = plazaLib.publish(plazaStore, {
      pid, packId: cleaned.id, pack: cleaned, author: msg.author, generate: makePlazaId,
    });
    if (result.error) return sendErr(ws, result.error, 'plazaPublish');
    savePlaza();
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'plazaPublished', id: result.id, packId: cleaned.id,
        name: cleaned.name, updatedAt: result.updatedAt, republished: result.republished,
      }));
    }
  },

  // 下架：只有发布者本人（同一 pid）能撤下；成功后该词包立即从广场消失，
  // 已订阅到别人本机的副本不受影响。
  plazaUnpublish(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    if (!pid) return sendErr(ws, '需要有效的本机身份才能下架', 'plazaUnpublish');
    const ok = plazaLib.unpublish(plazaStore, msg.id, pid);
    if (!ok) return sendErr(ws, '广场上没有这个词包，或你不是发布者', 'plazaUnpublish');
    savePlaza();
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'plazaUnpublished', id: String(msg.id || '') }));
    }
  },

  // 广场列表（公开只读，无需加入任何房间）：按热度/最新排序的摘要（含候选词预览，
  // 不回全文）。客户端随请求带上本机密钥，服务端派生 myPid 用于标出"我发布的"，
  // 客户端据此在自己的条目上显示下架入口。
  plazaList(ws, ctx, msg) {
    const sort = msg.sort === 'new' ? 'new' : 'hot';
    const { pid } = seasonLib.resolvePid(msg);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'plazaList', sort,
        packs: plazaLib.summaries(plazaStore, { myPid: pid, sort }) }));
    }
  },

  // 订阅：公开端点；返回词包快照供客户端存进本机词包（建房时与自建词包一样选用）。
  // 同一身份只计一次热度；无有效身份也能拿到词包，只是不计数。
  plazaSubscribe(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    const result = plazaLib.subscribe(plazaStore, msg.id, pid, Date.now());
    if (result.error) return sendErr(ws, result.error, 'plazaSubscribe');
    if (result.counted) savePlaza();
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'plazaPack', id: result.id,
        pack: { id: result.packId, ...result.pack }, subscribers: result.subscribers }));
    }
  },

  // 我的广场发布列表：客户端进入「我的词包」时拉取并与本机映射对账，
  // 跨设备发布的词包也能看到/下架；服务端已下架的条目不返回，客户端据此清掉本机残留。
  myPlaza(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'myPlaza', packs: pid ? plazaLib.listByOwner(plazaStore, pid) : [] }));
    }
  },

  startGame(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.startGame(room, ctx.playerId);
    if (err) return sendErr(ws, err);
    scheduleTurnTimer(room);
    broadcast(room);
  },

  play(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.playWord(room, ctx.playerId, msg);
    if (err) return sendErr(ws, err);
    broadcast(room);
  },

  reinforce(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.reinforce(room, ctx.playerId, msg.nodeId);
    if (err) return sendErr(ws, err);
    broadcast(room);
  },

  endTurn(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.endTurn(room, ctx.playerId);
    if (err) return sendErr(ws, err);
    scheduleTurnTimer(room);
    broadcast(room);
  },

  challenge(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.challenge(room, ctx.playerId, msg.nodeId);
    if (err) return sendErr(ws, err);
    clearTimeout(turnTimers.get(room.code)); // 计时已暂停
    broadcast(room);
  },

  resolve(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.resolveChallenge(room, ctx.playerId, msg.verdict);
    if (err) return sendErr(ws, err);
    scheduleTurnTimer(room); // 恢复计时
    broadcast(room);
  },

  replay(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return;
    if (room.phase !== 'ended') return sendErr(ws, '游戏结束后才能回放');
    sendTo(ctx.playerId, { type: 'replay', frames: game.buildReplay(room) });
  },

  // 历史与战绩：客户端凭本地保存的玩家 token 列表，换取每个房间的战绩摘要。
  // 观战 token 是临时只读身份，不纳入历史；失效 token（房间已删/数据已清）静默跳过，
  // 客户端按"只保留服务器认得的 token"顺势清理本地记录。
  history(ws, ctx, msg) {
    const list = Array.isArray(msg.tokens) ? msg.tokens.slice(0, 50) : [];
    const entries = [];
    for (const token of list) {
      const ref = tokens.get(token);
      if (!ref || ref.spectator) continue;
      const room = rooms.get(ref.roomCode);
      if (!room) continue;
      const summary = game.historySummary(room, ref.playerId);
      if (summary) entries.push({ token, ...summary });
    }
    entries.sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt));
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'history', entries }));
  },

  // 赛季排行榜（公开，只读，无需任何身份/房间）：支持按总分/胜场/胜率排序。
  // 任何已建立连接的客户端都能拉取——首页排行榜入口不依赖玩家是否在房间内。
  // 客户端可随请求带上本机密钥（与建房/个人页同一把，只在内存里单向派生、不落库），
  // 服务端在响应里回 myPid，用于客户端高亮"我"那一行、置顶显示我的汇总。
  leaderboard(ws, ctx, msg) {
    const sort = ['total', 'wins', 'rate'].includes(msg.sort) ? msg.sort : 'total';
    const rows = seasonLib.leaderboard(season, { sort });
    const { pid: myPid } = seasonLib.resolvePid(msg);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'leaderboard', sort,
        startedAt: season.startedAt, rows, myPid: myPid || null }));
    }
  },

  // 个人页（公开，只读）：可凭公开 pid（点排行榜某行）或本人密钥（"我的战绩"）查看
  // 场次/胜场/平局/平均得分/最高连锁等汇总。密钥经单向哈希换成 pid 后再查，密钥本身不落库。
  profile(ws, ctx, msg) {
    const { pid } = seasonLib.resolvePid(msg);
    const target = pid || (seasonLib.isValidPid(msg.pid) ? msg.pid : null);
    if (!target) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'profile', profile: null }));
      return;
    }
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'profile',
        profile: seasonLib.getProfile(season, target) }));
    }
  },
};

function ctxRoom(ctx) {
  const room = rooms.get(ctx.roomCode);
  if (!room) return null;
  return room;
}

// 纵深防御：game.js 内已按身份拒绝所有写操作，这里在协议层统一拦截，
// 保证观战 token 即使伪造消息也无法接词、加固、质疑、改规则或开始游戏。
const SPECTATOR_FORBIDDEN = new Set([
  'setRules', 'setWordPack', 'startGame', 'play', 'reinforce', 'endTurn', 'challenge', 'resolve',
]);

function sendErr(ws, message, context) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message, context }));
}

// ---------- HTTP + WS ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wssRef = { current: null };
function attachWebSocketServer() {
  // 每次启动创建新的 WebSocketServer：ws 的 close() 会移除 http server 上的 upgrade
  // 监听器，若复用旧实例，进程内 stop→start 后新连接握手只会拿到 HTTP 200。
  const wss = new WebSocketServer({ server });
  wssRef.current = wss;
  wss.on('connection', (ws) => {
    const ctx = { playerId: null, roomCode: null };
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const h = handlers[msg.type];
      if (h) {
        if (SPECTATOR_FORBIDDEN.has(msg.type) && ctx.playerId) {
          const r0 = rooms.get(ctx.roomCode);
          if (r0 && game.isSpectator(r0, ctx.playerId)) {
            return sendErr(ws, '观战者为只读，不能参与对局');
          }
        }
        try { h(ws, ctx, msg); }
        catch (e) { console.error(e); sendErr(ws, '服务器开小差了，请重试'); }
      }
    });
    ws.on('close', () => { if (ctx.playerId) detachSocket(ctx.playerId, ws); });
  });
}

// ---------- 启动 / 停止 ----------
// 默认直接运行时照常监听 8080；测试可 require 本模块后在临时端口上自启、跑完即停，
// 这样 `node --test`（会执行 test/ 下所有 .js，含 e2e.js）不再依赖外部先启动服务器。

function startServer(port = PORT) {
  return new Promise((resolve) => {
    // 先恢复赛季战绩：恢复房间时若发现结束房漏记，清理前可兜底补记进赛季
    loadSeason();
    loadRooms();
    loadShares();
    loadPlaza();
    scheduleRoomPruning();
    attachWebSocketServer();
    server.listen(port, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port, stop: stopServer });
    });
  });
}

function stopServer() {
  // 停掉所有定时器，避免保存防抖/回合/观战清理等句柄让进程挂住
  clearTimeout(saveTimer);
  clearTimeout(seasonSaveTimer);
  clearTimeout(sharesSaveTimer);
  clearTimeout(plazaSaveTimer);
  for (const t of turnTimers.values()) clearTimeout(t);
  for (const t of spectatorPruneTimers.values()) clearTimeout(t);
  if (roomPruneTimer) clearInterval(roomPruneTimer);
  turnTimers.clear();
  spectatorPruneTimers.clear();
  flushSeason(); // 最后一局战绩可能还在防抖队列里，停服前立即落盘
  flushShares(); // 最后一个分享同理
  flushPlaza();  // 最后一次广场发布/订阅同理
  const wss = wssRef.current;
  wssRef.current = null;
  return new Promise((resolve) => {
      const done = () => server.close(() => resolve());
      if (wss) wss.close(done); else done();
      // wss.close 只等正常关闭；强制终结仍在打开的连接（e2e 里有 ws.close 竞态）
      if (wss) for (const client of wss.clients) {
        try { client.terminate(); } catch { /* 已关闭 */ }
      }
    });
}

module.exports = { startServer, stopServer };

// 仅在被直接执行时启动服务（被测试 require 时不自启、不占用 8080）
if (require.main === module) {
  startServer(PORT).then(({ port }) => {
    console.log(`词语领地服务器已启动: http://localhost:${port}`);
  });
}
