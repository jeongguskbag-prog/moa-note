# 모아노트 (MoaNote)

손글씨 노트에 **HWP·PDF·사진**을 그대로 가져와 그 위에 S펜으로 쓰는 안드로이드 노트 앱.
광고 없음, 인터넷 권한 없음 — 노트는 휴대폰 안(앱 전용 저장 공간)에만 저장됩니다.

## 1단계 기능
- **노트**: 무지·줄 노트·모눈·점 종이, 쪽 추가·지우기, 제목, 자동 저장
- **펜**: S펜 필압(누르는 힘에 따라 굵기), 색 6가지·굵기 3단계 / **형광펜**(반투명) / **지우개**(문지른 획 지우기) / **글자**(누른 자리에 글자 상자)
- **S펜만** 켜기: 펜으로만 쓰고 손가락·손바닥은 화면 넘기기. 끄면 손가락으로 씀
- **두 손가락으로 확대·축소·이동** (모든 도구에서, 최대 4배)
- 되돌리기·다시 하기
- **가져오기**: HWP·HWPX(rhwp 엔진), PDF(pdf.js), 사진 → 쪽마다 노트 한 장(쪽 그림 위에 필기). 여러 파일 한 번에, 다른 앱의 "열기·공유"로도
- **내보내기**: 노트 전체를 PDF 로 저장하거나 카톡·메일·삼성 노트 등으로 보내기
- **폴더**(칩을 길게 누르면 이름 바꾸기·지우기), **검색**(제목·글자 상자), 목록에서 노트를 길게 누르면 메뉴

## 구조
- `app/src/main/assets/www/` — 화면(웹): `index.html`, `app.css`, `app.js`
  - 저장: WebView 의 IndexedDB (`notes`·`folders`·`blobs`). 쪽 배경 그림과 썸네일은 Blob
  - 쪽 = 크기 + 배경(종이 무늬 또는 가져온 쪽 그림) + 획(점마다 x, y, 필압) + 글자 상자
  - 화면에 가까운 쪽만 캔버스를 그리고 멀어지면 놓아 줌(긴 PDF 도 가볍게)
- `MainActivity.kt` — WebView 하나. 가져오기(시스템 파일 선택, HWP·PDF·사진 형식만), 저장(다른 이름으로 저장), PDF 보내기(FileProvider)
- 엔진은 저장소에 넣지 않고 `scripts/fetch-engines.sh` 가 빌드 때 받음 (버전·sha512 고정)
  - HWP: [@rhwp/core](https://www.npmjs.com/package/@rhwp/core) 0.9.0 (MIT)
  - PDF: [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) 5.4.449 (Apache-2.0, Mozilla pdf.js)

## 빌드
```bash
bash scripts/fetch-engines.sh   # 엔진 받기 (한 번)
./gradlew assembleDebug
```
GitHub Actions: 푸시·PR 마다 `Build`(Artifacts `MoaNote-debug`), 출시용은 Actions → **Release build** (`MoaNote-release`: AAB·APK).
서명 정보는 GitHub Secrets 로만: `MOANOTE_KEYSTORE_BASE64`, `MOANOTE_KEYSTORE_PASSWORD`, `MOANOTE_KEY_ALIAS`, `MOANOTE_KEY_PASSWORD`

## 알아 둘 점
- 가져온 HWP·PDF 는 쪽 그림(약 192dpi)이 되어 그 위에 쓰는 방식 — 원본 글자를 고치는 것은 2단계(HWP 편집기·PDF 편집기 연결)
- 내보낸 PDF 의 글자는 그림이라 검색·복사 안 됨
- 노트는 앱을 지우면 함께 지워짐 → 백업·복원은 2단계
- 개인정보처리방침: `docs/privacy/index.html` → https://jeongguskbag-prog.github.io/moa-note/privacy/ (Settings → Pages → `main` / `docs`)

## 다음 단계
2단계: 가져온 HWP·PDF 의 글자 고치기, 워드·엑셀·파워포인트 가져오기, 올가미 선택·옮기기, 노트 백업·복원
3단계: 녹음하면서 필기, 서명 저장, 템플릿 더하기
