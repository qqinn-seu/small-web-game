# small-web-game

1

双人浏览器五子棋，采用 Vite + TypeScript + Canvas 前端和 Node.js + Express + Socket.IO 服务端。

完整产品方案见 [SchemeDesign.md](./SchemeDesign.md)，里程碑与验收见 [TODO.md](./TODO.md)。当前开发范围为 M1：房间创建/加入、双方准备、真实联机下棋和服务端胜负判定。像素小人、画脸、音效与 Render 上线留待后续里程碑。

## 本地运行

需要 Node.js 24。使用 nvm 时：

```bash
nvm install
nvm use
npm ci
npm run dev
```

打开 http://localhost:5173 。Vite 将 Socket.IO 请求代理到 http://127.0.0.1:3000 。首次输入昵称，创建房间后把邀请链接或房间码发给另一个玩家；双方准备后开始。

生产模式本地验证：

```bash
npm run build
npm start
```

打开 http://localhost:3000 。一个 Node 服务同时提供静态前端与 Socket.IO，监听 0.0.0.0，读取环境变量 PORT（缺省 3000）。例如 `PORT=4000 npm start` 可变更生产端口；开发代理默认仍为 3000。`.env.example` 是部署变量说明，当前不会自动加载本地 `.env`。

## 规则与操作

15×15 棋盘，黑棋先手，无禁手，任意横/竖/斜方向连续五子及以上获胜；棋盘填满且无胜者为平局。点击或触摸交叉点落子，服务端确认之前显示“落子中”，不会先在本地放棋子。

使用两个独立浏览器窗口验证：一人创建、一人通过邀请加入，双方准备，轮流落子并检查结果一致。M1身份仅在页面内存中；刷新恢复、跨标签身份规则及再来一局在M2实现。完整后续版本测试须使用不同浏览器或普通+无痕环境，因为localStorage将共享同源身份。

## 自动检查

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

端到端测试需先构建生产产物，Playwright会启动生产服务，使用隔离浏览器Context代表真人客户端。服务端集成测试使用真实Socket.IO客户端，不以模拟本地下棋代替联机。

## 关键设计

服务端保存棋盤、轮次与结果并且唯一判定胜负。输入经过严格校验：当前身份和控制连接、房间实例、本局、阶段、轮次、坐标、空位和moveNo。客户端自报其他身份或非法参数不被信任。

每个业务意图有actionId；重复请求返回原确认、相同ID异参数拒绝。房间version单调递增；快照与增量是状态来源，ACK只控制等待不推进版本。版本跳号重新请求完整快照。满房请求不会加入广播组，也不会得到棋局和成员状态。

公开状态和类型位于shared，身份密钥/哈希、权限和最终规则仅在server。房间在单Node进程的内存中，不支持水平扩容。

## 当前限制与后续里程碑

M1无像素美术、画脸、音效、悔棋、聊天或账号。正常胜负直接显示基础结算；完整drawing阶段M3加入。双方再战、主动离开、60秒重连裁决和10分钟房间销毁在M2加入。

M1页面内身份仅用于当前Socket鉴权，刷新后不恢复原座位。断线可显示暂停，但不要把底层Socket自动重连当成已经实现完整房间恢复；测试时请用新房间开始新会话。完整持久身份恢复在M2提供。

服务端所有状态均在内存：停止、重启或重新部署丢失房间、身份与棋局。完整版本也不会跨进程恢复；未来累计图案同样不会永久保存。

## 部署状态

Render线上部署为M5，本阶段尚未上线，没有可交付的生产URL。方案中的部署命令为 `npm ci && npm run build`、`npm start`；计划交付根目录render.yaml，并使用显式Free、单实例、/healthz和process.env.PORT。

完整逐步部署方式与免费档冷启动/休眠限制已记录在SchemeDesign.md，M5将补齐实际配置和线上测试结果。不要用开发预览地址代替Render交付地址。
