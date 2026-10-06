# 一起把專案做好

任務與進度以本 repo 的 [GitHub Issues](https://github.com/FreeTWAI-AI/freedom-browser-extension/issues) 為準；程式修改與審查以 PR 為準。自由工坊的共創頁協助大家找到專案、角色和任務入口，repo 權限仍由維護者管理。

## 從一張明確的 Issue 開始

在 [任務表單](https://github.com/FreeTWAI-AI/freedom-browser-extension/issues/new?template=task.yml) 說清楚：誰遇到什麼問題、這輪範圍、完成條件、怎麼驗證、需要哪些角色，以及依賴的資料或其他任務。

認領前，先讀 Issue 的最新討論與 [AGENTS.md](AGENTS.md)。在 Issue 留言說明你想處理的範圍、預計交付、需要的協助和可投入時間，等維護者確認後再視為已分派。維護者已直接授權的工作沿用該授權，並把範圍連回 Issue，避免其他人重複實作。

## 使用自己的分支交付

1. 使用自己的 fork，或維護者已授權的 repo 工作分支。
2. 每張任務建立獨立分支，保持修改在約定範圍內。
3. 保留現有作者、來源和授權資訊；不要提交客戶私密素材、登入憑證或 API key。授權尚未決定（`NOASSERTION`），不要新增 LICENSE 或自行宣告授權。
4. 按完成條件驗證成果，開 PR 並連回 Issue。PR 送審不代表已完成驗收或合併。

使用 AI 協作時，請把 Issue 與本 repo 的操作說明一起交給工具；檢查它實際修改的內容與測試結果，並在 PR 註明工具和協作範圍。

## 檢查方式

使用 Node.js 24，先讀 `package.json` 與 [docs/architecture.md](docs/architecture.md)。目前的本機命令是：

```sh
npm run typecheck
npm test
npm run build
npm run build:production
node scripts/verify-contracts.mjs
python3 scripts/verify-project-manifest.py
```

`npm test` 使用行程內的假平台，不會連到自由工坊。`npm run test:browser` 只在本機 Chromium 對 loopback 假平台執行，不在 `npm test` 裡。文件任務可以提供實際連結和步驟核對結果。PR 如實列出執行過、未執行與失敗的項目。

畫面字用繁體中文，元件尺寸見 [DESIGN.md](DESIGN.md)。
