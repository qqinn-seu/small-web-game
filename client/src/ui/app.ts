import type { RoomState } from '../../../shared/models.js';
import type { RoomEntryData } from '../../../shared/protocol.js';
import { BoardRenderer } from '../canvas/board-renderer.js';
import { bindBoardInput } from '../input/board-input.js';
import type { ClientIdentity } from '../network/socket-client.js';

export interface AppActions {
  establishIdentity: (nickname: string) => void;
  createRoom: () => void;
  joinRoom: (roomCode: string) => void;
  setReady: () => void;
  placeMove: (x: number, y: number) => void;
  leaveRoom: () => void;
  resolveDisconnect: (targetPlayerId: string, decision: 'claim_win' | 'keep_waiting') => void;
}

interface SeatNodes {
  card: HTMLElement;
  color: HTMLElement;
  name: HTMLElement;
  online: HTMLElement;
  ready: HTMLElement;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`缺少界面元素：${selector}`);
  return element;
}

function invitationFrom(roomCode: string, path?: string): string {
  const route = path || `/r/${encodeURIComponent(roomCode)}`;
  return new URL(route, window.location.origin).toString();
}

export class GameUI {
  private readonly nicknameInput: HTMLInputElement;
  private readonly identityPanel: HTMLElement;
  private readonly lobby: HTMLElement;
  private readonly gamePanel: HTMLElement;
  private readonly fullRoomNote: HTMLElement;
  private readonly roomCodeInput: HTMLInputElement;
  private readonly createButton: HTMLButtonElement;
  private readonly joinButton: HTMLButtonElement;
  private readonly joinPanel: HTMLElement;
  private readonly readyButton: HTMLButtonElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly claimWinButton: HTMLButtonElement;
  private readonly keepWaitingButton: HTMLButtonElement;
  private readonly reconnectCountdown: HTMLElement;
  private readonly roomCode: HTMLElement;
  private readonly playerName: HTMLElement;
  private readonly version: HTMLElement;
  private readonly currentTurn: HTMLElement;
  private readonly statusMessage: HTMLElement;
  private readonly serverStatus: HTMLElement;
  private readonly syncMessage: HTMLElement;
  private readonly pendingMove: HTMLElement;
  private readonly moveCount: HTMLElement;
  private readonly resultMessage: HTMLElement;
  private readonly invitePanel: HTMLElement;
  private readonly inviteInput: HTMLInputElement;
  private readonly copyInviteButton: HTMLButtonElement;
  private readonly boardCanvas: HTMLCanvasElement;
  private readonly seats: SeatNodes[];
  private readonly renderer: BoardRenderer;
  private readonly unbindBoardInput: () => void;
  private readonly clockTimer: number;

  private room: RoomState | null = null;
  private identity: ClientIdentity | null = null;
  private networkReady = false;
  private roomEntryBusy = false;
  private readyBusy = false;
  private movePending = false;
  private roomFull = false;
  private synchronizing = false;
  private restoringRoom = false;
  private invitation: string | null = null;
  private connectionText = '正在连接服务器。';
  private messageText = '';
  private serverText = '服务器：正在连接';
  private clockOffsetMs = 0;

  public constructor(root: HTMLElement, private readonly actions: AppActions, initialRoomCode?: string) {
    root.innerHTML = `
      <main class="app-shell">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark" aria-hidden="true">●</div>
            <div><h1>同桌五子棋</h1><p>两个人，一盘认真下完的棋。</p></div>
          </div>
          <span class="version" data-testid="room-version">M2 · v0.2.0</span>
        </header>

        <section class="connection-strip" aria-live="polite">
          <strong class="server-status">服务器：正在连接</strong>
          <span class="status-message" data-testid="status-message">正在连接服务器。</span>
          <span class="sync-message" hidden>正在同步房间状态…</span>
        </section>

        <section class="identity-panel panel">
          <div class="panel-inner">
            <h2>先留下一个昵称</h2>
            <p>身份只保存在当前浏览器，用于刷新后恢复自己的座位；不需要账号。</p>
            <form class="identity-form"><div class="form-row">
              <label class="field">昵称（1–12 字符）
                <input data-testid="nickname-input" maxlength="12" autocomplete="nickname" placeholder="例如：小林" required />
              </label>
              <button type="submit">建立身份</button>
            </div></form>
          </div>
        </section>

        <section class="lobby panel" hidden>
          <div class="panel-inner">
            <div class="full-room-note" hidden>房间已满，无法查看原房间状态。请创建一个新房间。</div>
            <div class="lobby-grid">
              <div>
                <h2>开一盘新棋</h2>
                <p class="muted">创建后把邀请链接发给对方，两人准备即可开始。</p>
                <button data-testid="create-room" type="button">创建房间</button>
              </div>
              <div class="lobby-divider">
                <h2>加入好友房间</h2>
                <form class="join-form"><div class="form-row">
                  <label class="field">房间码
                    <input data-testid="room-code-input" maxlength="32" autocapitalize="characters" autocomplete="off" placeholder="输入房间码" />
                  </label>
                  <button data-testid="join-room" type="submit">加入房间</button>
                </div></form>
              </div>
            </div>
          </div>
        </section>

        <section class="game-layout" hidden>
          <aside class="side-stack">
            <section class="room-card panel">
              <div class="room-meta"><span class="room-label">房间码</span><strong class="room-code" data-testid="room-code">—</strong></div>
              <p class="player-line">你是：<strong class="own-player-name" data-testid="own-player-name">未建立身份</strong></p>
            </section>
            <section class="seat-list" aria-label="玩家座位">
              <article class="seat-card" data-seat="A">
                <div class="seat-top"><span class="seat-color">黑棋</span><span class="seat-online">空位</span></div>
                <div class="seat-bottom"><strong class="seat-name" data-testid="player-name">等待玩家</strong></div>
                <div class="seat-ready">未准备</div>
              </article>
              <article class="seat-card" data-seat="B">
                <div class="seat-top"><span class="seat-color">白棋</span><span class="seat-online">空位</span></div>
                <div class="seat-bottom"><strong class="seat-name" data-testid="player-name">等待玩家</strong></div>
                <div class="seat-ready">未准备</div>
              </article>
            </section>
            <section class="turn-card">
              <strong class="turn-label">等待房间状态</strong>
              <p class="reconnect-countdown" data-testid="reconnect-countdown" hidden></p>
              <p class="rules">规则：15×15，黑棋先手，无禁手，连续五子及以上获胜。</p>
            </section>
            <div class="room-actions">
              <button class="ready-button" data-testid="ready-button" type="button" hidden>准备开始</button>
              <button class="secondary leave-button" data-testid="leave-button" type="button" hidden>离开房间</button>
            </div>
            <div class="disconnect-actions" hidden>
              <button data-testid="claim-win-button" type="button" hidden>判定获胜</button>
              <button class="secondary" data-testid="keep-waiting-button" type="button" hidden>继续等待</button>
            </div>
            <section class="invite-panel panel" hidden>
              <h3>邀请对方加入</h3>
              <p>可直接复制；若浏览器不允许自动复制，请手动复制下方链接。</p>
              <div class="invite-row"><input readonly aria-label="邀请链接" /><button class="secondary" type="button">复制链接</button></div>
            </section>
          </aside>

          <section class="board-panel panel">
            <canvas class="board-canvas" data-testid="board-canvas" aria-label="15乘15五子棋棋盘"></canvas>
            <div class="board-caption"><span data-testid="move-count">第 0 手 / 225</span><span class="pending-move" data-testid="pending-move" hidden>落子中</span></div>
            <p class="result-message" data-testid="result-message" hidden></p>
          </section>
        </section>
      </main>`;

    this.nicknameInput = required(root, '[data-testid="nickname-input"]');
    this.identityPanel = required(root, '.identity-panel');
    this.lobby = required(root, '.lobby');
    this.gamePanel = required(root, '.game-layout');
    this.fullRoomNote = required(root, '.full-room-note');
    this.roomCodeInput = required(root, '[data-testid="room-code-input"]');
    this.createButton = required(root, '[data-testid="create-room"]');
    this.joinButton = required(root, '[data-testid="join-room"]');
    this.joinPanel = required(root, '.lobby-divider');
    this.readyButton = required(root, '[data-testid="ready-button"]');
    this.leaveButton = required(root, '[data-testid="leave-button"]');
    this.claimWinButton = required(root, '[data-testid="claim-win-button"]');
    this.keepWaitingButton = required(root, '[data-testid="keep-waiting-button"]');
    this.reconnectCountdown = required(root, '[data-testid="reconnect-countdown"]');
    this.roomCode = required(root, '[data-testid="room-code"]');
    this.playerName = required(root, '[data-testid="own-player-name"]');
    this.version = required(root, '[data-testid="room-version"]');
    this.currentTurn = required(root, '.turn-label');
    this.statusMessage = required(root, '[data-testid="status-message"]');
    this.serverStatus = required(root, '.server-status');
    this.syncMessage = required(root, '.sync-message');
    this.pendingMove = required(root, '[data-testid="pending-move"]');
    this.moveCount = required(root, '[data-testid="move-count"]');
    this.resultMessage = required(root, '[data-testid="result-message"]');
    this.invitePanel = required(root, '.invite-panel');
    this.inviteInput = required(root, '.invite-row input');
    this.copyInviteButton = required(root, '.invite-row button');
    this.seats = ['A', 'B'].map((seatId) => {
      const card = required<HTMLElement>(root, `[data-seat="${seatId}"]`);
      return {
        card,
        color: required(card, '.seat-color'),
        name: required(card, '.seat-name'),
        online: required(card, '.seat-online'),
        ready: required(card, '.seat-ready'),
      };
    });

    this.boardCanvas = required<HTMLCanvasElement>(root, '[data-testid="board-canvas"]');
    this.renderer = new BoardRenderer(this.boardCanvas);
    this.unbindBoardInput = bindBoardInput(this.boardCanvas, {
      canPlace: () => this.canPlace(),
      onPlaceIntent: (x, y) => this.actions.placeMove(x, y),
    });

    required<HTMLFormElement>(root, '.identity-form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.actions.establishIdentity(this.nicknameInput.value);
    });
    this.createButton.addEventListener('click', () => this.actions.createRoom());
    required<HTMLFormElement>(root, '.join-form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.actions.joinRoom(this.roomCodeInput.value.trim().toUpperCase());
    });
    this.readyButton.addEventListener('click', () => this.actions.setReady());
    this.leaveButton.addEventListener('click', () => this.actions.leaveRoom());
    this.claimWinButton.addEventListener('click', () => this.resolveOpponent('claim_win'));
    this.keepWaitingButton.addEventListener('click', () => this.resolveOpponent('keep_waiting'));
    this.copyInviteButton.addEventListener('click', () => void this.copyInvitation());

    if (initialRoomCode) {
      this.roomCodeInput.value = initialRoomCode;
      this.messageText = '已从邀请链接填入房间码；请先建立昵称身份再加入。';
    }
    this.clockTimer = window.setInterval(() => this.render(), 1_000);
    this.render();
  }

  public setIdentity(identity: ClientIdentity | null, ready: boolean): void {
    this.identity = identity;
    this.networkReady = ready;
    if (identity) this.nicknameInput.value = identity.nickname;
    this.render();
  }

  /** Display a saved nickname while its private credential is being verified. */
  public setRestoringIdentity(nickname: string): void {
    this.nicknameInput.value = nickname;
    this.connectionText = '正在恢复本浏览器保存的身份…';
    this.render();
  }

  public getNickname(): string {
    return this.nicknameInput.value.trim();
  }

  public setNetworkReady(ready: boolean): void {
    this.networkReady = ready;
    this.render();
  }

  public setClockOffset(serverTime: number): void {
    if (Number.isFinite(serverTime)) this.clockOffsetMs = serverTime - Date.now();
    this.render();
  }

  public setRoom(room: RoomState | null): void {
    const enteringPlaying = room?.phase === 'playing' && this.room?.phase !== 'playing';
    this.room = room;
    if (room?.phase === 'playing') this.messageText = '';
    this.renderer.setRoom(room);
    this.render();
    if (enteringPlaying) {
      window.requestAnimationFrame(() => {
        this.boardCanvas.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      });
    }
  }

  public setRoomEntryBusy(busy: boolean): void {
    this.roomEntryBusy = busy;
    this.render();
  }

  public setReadyBusy(busy: boolean): void {
    this.readyBusy = busy;
    this.render();
  }

  public setMovePending(pending: boolean): void {
    this.movePending = pending;
    this.render();
  }

  public setRoomFull(full: boolean): void {
    this.roomFull = full;
    this.render();
  }

  public setSynchronizing(synchronizing: boolean): void {
    this.synchronizing = synchronizing;
    this.render();
  }

  public setRestoringRoom(restoring: boolean): void {
    this.restoringRoom = restoring;
    this.render();
  }

  public setInvitation(entry: RoomEntryData | null): void {
    this.invitation = entry ? invitationFrom(entry.roomCode, entry.invitationPath) : null;
    this.render();
  }

  public setConnection(message: string): void {
    this.connectionText = message;
    this.render();
  }

  public setServerStatus(message: string): void {
    this.serverText = message;
    this.render();
  }

  public notify(message: string): void {
    this.messageText = message;
    this.render();
  }

  public clearNotice(): void {
    this.messageText = '';
    this.render();
  }

  public destroy(): void {
    window.clearInterval(this.clockTimer);
    this.unbindBoardInput();
    this.renderer.destroy();
  }

  private render(): void {
    const ownSeat = this.room?.seats.find((seat) => seat?.playerId === this.identity?.playerId) ?? null;
    const roomCode = this.room?.roomCode ?? '';
    const invite = this.invitation ?? (roomCode ? invitationFrom(roomCode) : '');

    this.identityPanel.hidden = Boolean(this.identity);
    this.lobby.hidden = Boolean(this.room) || this.restoringRoom;
    this.gamePanel.hidden = !this.room;
    this.fullRoomNote.hidden = !this.roomFull || Boolean(this.room);
    this.joinPanel.hidden = this.roomFull && !this.room;
    // A first create/join click is also the approved identity-establishment
    // action. Once an identity exists, normal M2 network/snapshot gating
    // applies and no room-changing intent can pass during recovery.
    const admissionBlocked = Boolean(this.identity) && !this.networkReady;
    this.createButton.disabled = this.roomEntryBusy || Boolean(this.room) || admissionBlocked;
    this.joinButton.disabled = this.roomEntryBusy || Boolean(this.room) || admissionBlocked;
    this.roomCodeInput.disabled = this.roomEntryBusy || Boolean(this.room) || admissionBlocked;
    this.createButton.textContent = this.roomFull && !this.room ? '创建新房间' : '创建房间';
    this.nicknameInput.disabled = Boolean(this.identity);

    this.roomCode.textContent = roomCode || '—';
    this.playerName.textContent = this.identity?.nickname ?? '未建立身份';
    this.version.textContent = this.room ? `M2 · v0.2.0 · 状态 v${this.room.version}` : 'M2 · v0.2.0';
    this.serverStatus.textContent = this.serverText;
    this.statusMessage.textContent = this.messageText || (this.room?.phase === 'playing' ? this.turnText() : this.connectionText);
    this.syncMessage.hidden = !this.synchronizing || this.restoringRoom;
    this.pendingMove.hidden = !this.movePending;
    this.moveCount.textContent = `第 ${this.room?.round?.moveNo ?? 0} 手 / 225`;

    this.renderSeats();
    this.currentTurn.textContent = this.turnText();
    this.renderReady(ownSeat);
    this.renderLeave(ownSeat);
    this.renderDisconnectDecision(ownSeat);
    this.invitePanel.hidden = !this.room;
    this.inviteInput.value = invite;
    this.renderResult();
  }

  private renderSeats(): void {
    const round = this.room?.round ?? null;
    this.seats.forEach((nodes, index) => {
      const seat = this.room?.seats[index] ?? null;
      const fallbackColor = index === 0 ? '黑棋' : '白棋';
      let color = fallbackColor;
      if (seat && round) {
        color = !round.participantIds.includes(seat.playerId)
          ? '等待新局'
          : seat.playerId === round.blackPlayerId
            ? '黑棋'
            : '白棋';
      }
      nodes.color.textContent = color;
      nodes.name.textContent = seat?.nickname || '等待玩家';
      nodes.online.textContent = seat ? (seat.connected ? '在线' : '离线') : '空位';
      nodes.online.classList.toggle('offline', Boolean(seat && !seat.connected));
      nodes.ready.textContent = seat ? (seat.ready ? '已准备' : '未准备') : '等待加入';
      nodes.card.classList.toggle('seat-card--self', seat?.playerId === this.identity?.playerId);
      if (seat) nodes.card.dataset.playerId = seat.playerId;
      else delete nodes.card.dataset.playerId;
    });
  }

  private turnText(): string {
    if (!this.room) return this.restoringRoom ? '正在恢复原房间座位' : '等待房间状态';
    const round = this.room.round;
    if (!round) return '等待两位玩家准备开始';
    const ownIsParticipant = Boolean(this.identity && round.participantIds.includes(this.identity.playerId));
    if (round.result || this.room.phase === 'finished') {
      return ownIsParticipant ? '本局已经结束，可以准备再来一局' : '上一局已经结束，等待新局';
    }
    if (round.paused) {
      const opponentId = ownIsParticipant
        ? round.participantIds.find((playerId) => playerId !== this.identity?.playerId)
        : undefined;
      const opponent = this.room.seats.find((seat) => seat?.playerId === opponentId) ?? null;
      return opponent && !opponent.connected ? '对方掉线，等待重连' : '对局已暂停，等待服务器状态更新';
    }
    if (this.room.phase !== 'playing' || !round.turnPlayerId) return '等待对局开始';
    const seat = this.room.seats.find((item) => item?.playerId === round.turnPlayerId) ?? null;
    const side = round.turnPlayerId === round.blackPlayerId ? '黑棋' : '白棋';
    return round.turnPlayerId === this.identity?.playerId
      ? `轮到你落子（${side}）`
      : `轮到 ${seat?.nickname || '对方'} 落子（${side}）`;
  }

  private renderReady(ownSeat: RoomState['seats'][number] | null): void {
    const phase = this.room?.phase;
    const show = Boolean(ownSeat && (phase === 'waiting' || phase === 'finished'));
    this.readyButton.hidden = !show;
    if (!show) return;
    this.readyButton.textContent = ownSeat?.ready
      ? '取消准备'
      : phase === 'finished'
        ? '再来一局'
        : '准备开始';
    this.readyButton.disabled = !this.networkReady || this.readyBusy || this.synchronizing || this.restoringRoom;
  }

  private renderLeave(ownSeat: RoomState['seats'][number] | null): void {
    const show = Boolean(ownSeat);
    this.leaveButton.hidden = !show;
    if (!show) return;
    this.leaveButton.textContent = this.room?.phase === 'playing' ? '离开并认输' : '离开房间';
    this.leaveButton.disabled = !this.networkReady || this.synchronizing || this.restoringRoom;
  }

  private renderDisconnectDecision(ownSeat: RoomState['seats'][number] | null): void {
    const round = this.room?.round;
    const ownIsParticipant = Boolean(round && this.identity && round.participantIds.includes(this.identity.playerId));
    const opponentId = ownIsParticipant
      ? round?.participantIds.find((playerId) => playerId !== this.identity?.playerId)
      : undefined;
    const opponent = this.room?.seats.find((seat) => seat?.playerId === opponentId) ?? null;
    const waitingForOpponent = Boolean(
      round
      && this.room?.phase === 'playing'
      && round.paused
      && ownSeat?.connected
      && opponent
      && !opponent.connected,
    );
    this.reconnectCountdown.hidden = !waitingForOpponent;
    if (waitingForOpponent) {
      const deadline = opponent?.reconnectDeadline;
      const seconds = typeof deadline === 'number'
        ? Math.max(0, Math.ceil((deadline - (Date.now() + this.clockOffsetMs)) / 1_000))
        : null;
      this.reconnectCountdown.textContent = seconds === null
        ? '对方掉线，等待重连。'
        : seconds > 0
          ? `对方掉线，等待重连（${seconds} 秒）。`
          : '对方掉线已超过宽限期，可以判定获胜或继续等待。';
    } else {
      this.reconnectCountdown.textContent = '';
    }

    const graceElapsed = opponent?.reconnectDeadline !== null && opponent?.reconnectDeadline !== undefined
      && Date.now() + this.clockOffsetMs >= opponent.reconnectDeadline;
    const canDecide = Boolean(waitingForOpponent && opponent?.disconnectDecisionAvailable && graceElapsed);
    const actions = this.claimWinButton.parentElement;
    if (actions) actions.hidden = !canDecide;
    this.claimWinButton.hidden = !canDecide;
    this.keepWaitingButton.hidden = !canDecide;
    const disabled = !this.networkReady || this.synchronizing || this.restoringRoom;
    this.claimWinButton.disabled = disabled;
    this.keepWaitingButton.disabled = disabled;
  }

  private renderResult(): void {
    const result = this.room?.round?.result;
    if (!result || this.room?.phase !== 'finished') {
      this.resultMessage.hidden = true;
      this.resultMessage.textContent = '';
      return;
    }
    const isParticipant = Boolean(this.identity && this.room.round?.participantIds.includes(this.identity.playerId));
    let outcome: string;
    if (!isParticipant) {
      outcome = '上一局已结束；你是新加入的玩家，等待新局。';
    } else if (!result.winnerPlayerId || result.reason === 'draw') {
      outcome = '平：本局平局。';
    } else if (result.winnerPlayerId === this.identity?.playerId) {
      outcome = '胜：你赢了本局。';
    } else {
      outcome = '负：本局失利。';
    }
    this.resultMessage.textContent = `${outcome} 画脸表现将在后续里程碑开放；再战现已可用。`;
    this.resultMessage.hidden = false;
  }

  private canPlace(): boolean {
    const round = this.room?.round;
    return Boolean(
      this.networkReady
      && !this.synchronizing
      && !this.restoringRoom
      && !this.movePending
      && this.room?.phase === 'playing'
      && round
      && !round.paused
      && !round.result
      && round.turnPlayerId === this.identity?.playerId,
    );
  }

  private resolveOpponent(decision: 'claim_win' | 'keep_waiting'): void {
    const round = this.room?.round;
    const playerId = round?.participantIds.find((candidate) => candidate !== this.identity?.playerId);
    if (playerId) this.actions.resolveDisconnect(playerId, decision);
  }

  private async copyInvitation(): Promise<void> {
    if (!this.inviteInput.value) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(this.inviteInput.value);
      this.notify('邀请链接已复制。');
    } catch {
      this.inviteInput.focus();
      this.inviteInput.select();
      this.notify('浏览器未允许自动复制，请手动复制已选中的邀请链接。');
    }
  }
}
