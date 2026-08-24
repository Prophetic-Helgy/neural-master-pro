# Neural Master Pro 2.2

전문가용 AI 기반 오디오 마스터링 제품군. 레퍼런스 트랙 분석, 고급 모니터링, 하드웨어 온도 체크 기능을 갖추고 있습니다.

## 주요 기능
- AI 마스터링 및 레퍼런스 비교
- LUFS, 피크, RMS, 위상 측정
- 타임라인 자르기 및 비디오/오디오 내보내기
- 하드웨어 표시: 제목 막대의 CPU/GPU 배지는 실제 장치 이름과 센서가 있을 때 실제 온도를 표시합니다(없으면 «--°C»)


---
**고지 사항**: 이 소프트웨어는 무료로 제공되지만, 제작자는 '좋아요', 구독 및 기부를 거절하지 않습니다! ❤️

**제작자:** Oleg Abezov
**Telegram:** [@DunkanMcLeod](https://t.me/DunkanMcLeod)
**Instagram:** [@only_monochrome](https://instagram.com/only_monochrome)


## 설치 (Windows)

1. 리포지토리를 다운로드하고 원하는 폴더(예: `C:\Your\Path\To\Neural_Master_Pro`)에 압축을 풉니다.
2. **Windows PowerShell**을 엽니다(정확한 하드웨어 센서 작동을 위해 관리자 권한으로 실행 권장).
3. 폴더로 이동합니다: `cd C:\Your\Path\To\Neural_Master_Pro`
4. 종속성 설치: `npm install`
5. 실행 파일 빌드: `npm run build:exe`
6. 설정 파일(예: `Neural Master Pro 2.2 Setup 2.2.0.exe`)이 `release` 폴더 안에 생성됩니다.