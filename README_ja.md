# Neural Master Pro 2.2

プロ仕様のAI駆動型オーディオマスタリングスイート。リファレンストラック、インテリジェントな分析、CPU/GPUハードウェアモニターを備えています。

## 主な機能
- AI マスタリングとリファレンスマッチング
- LUFS、ピーク、RMS、位相同期分析
- トリミング、WAV、HDビデオのエクスポート
- ハードウェア表示：タイトルバーの CPU/GPU バッジはデバイスの実名と、センサーがある場合の実温度を表示（なければ「--°C」）


---
**免責事項**: このソフトウェアは無料で提供されていますが、著者は「いいね」、購読、寄付を拒否しません！❤️

**著者:** Oleg Abezov
**Telegram:** [@DunkanMcLeod](https://t.me/DunkanMcLeod)
**Instagram:** [@only_monochrome](https://instagram.com/only_monochrome)


## インストール (Windows)

1. リポジトリをダウンロードし、希望するフォルダ（例：`C:\Your\Path\To\Neural_Master_Pro`）に展開します。
2. **Windows PowerShell** を開きます（正確なハードウェアセンサー情報の取得のため、管理者として実行することを推奨します）。
3. フォルダに移動します：`cd C:\Your\Path\To\Neural_Master_Pro`
4. 依存関係のインストール：`npm install`
5. 実行可能ファイルのビルド：`npm run build:exe`
6. セットアップファイル（例：`Neural Master Pro 2.2 Setup 2.2.0.exe`）が `release` フォルダ内に生成されます。