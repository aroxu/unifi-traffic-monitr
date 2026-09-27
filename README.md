# UniFi Traffic Monitor

구현 중인 UniFi 클라이언트 트래픽 모니터입니다. 현재 **실장비 PoC, 관리자 로그인, PostgreSQL, 클라이언트·장비 동기화, 원본 카운터/체크포인트 수집**이 동작합니다. `reported` 범위는 UniFi API 원본 카운터의 정상 차분을 기간별로 표시합니다. 인터넷/LAN 포함 범위와 실제 전송량 대비 오차는 확인되지 않았으므로 인터넷 전용 사용량으로 해석하지 않습니다. 실장비 확인 결과는 [POC_RESULTS.md](POC_RESULTS.md)에 기록합니다.

## 준비

- Node.js 24, pnpm 12.4.1, PostgreSQL 17 또는 Docker Compose
- UCG 로컬 HTTPS 주소, 읽기 전용 API 키 또는 로컬 세션 쿠키, 내부 사이트 이름 및 공식 사이트 UUID
- 실서비스에서는 신뢰할 수 있는 인증서를 사용합니다. TLS 검증을 끄는 옵션은 없습니다.

```sh
cp .env.example .env
pnpm install
pnpm test
pnpm typecheck
```

`.env`는 Git에 포함되지 않습니다. Compose는 `deploy` 디렉터리의 파일을 사용합니다.

브라우저 검증은 웹이 실행 중일 때 `E2E_ADMIN_EMAIL`과 `E2E_ADMIN_PASSWORD`를 현재 셸에만 설정한 뒤 `pnpm --filter @utm/web e2e`로 실행합니다. 첫 실행에 브라우저가 없다면 `pnpm --filter @utm/web exec playwright install chromium`을 사용합니다. 테스트는 1440px 데스크톱과 390px 모바일에서 보호된 API, 로그인, 목록 필터, 상세를 확인합니다. 별도 검증 DB에 사용량 구간이 있으면 `E2E_BASE_URL`과 `E2E_CHART_CLIENT_ID`를 지정해 차트 표시와 기간 전환도 시험할 수 있습니다.

빈 DB 초기 화면 검증은 마이그레이션과 관리자 계정 생성이 끝난 **별도 시험 DB·웹**에만 `E2E_EMPTY_DB=1`과 `E2E_BASE_URL`을 지정해 `e2e/empty-state.spec.ts`를 실행합니다. 운영 DB에는 빈 상태 시험을 실행하지 않습니다.

## 읽기 전용 PoC

환경변수 `UNIFI_URL`, `UNIFI_SITE`, `UNIFI_API_KEY` 또는 `UNIFI_COOKIE`를 설정한 뒤 `pnpm poc`를 실행합니다. 공식 사이트 목록의 모든 페이지에서 UUID와 내부 이름을 확인하고 내부 클라이언트 카운터 필드의 존재 여부를 확인합니다. 출력에는 원본 응답, 자격 증명, MAC, 클라이언트 이름, IP가 없고 실행마다 바뀌는 익명 ID가 들어갑니다. 내부 API 접근에 키 권한이 없으면 로컬 읽기 전용 계정의 쿠키를 사용할 수 있는지 장비에서 확인해야 합니다.

PoC 결과만으로 `rx_bytes`가 업로드/다운로드 중 무엇인지, 인터넷 전용인지 판단하지 않습니다. 현재 운영은 사용자의 선택에 따라 별도의 통제 전송 없이 API 원본 카운터를 `reported` 범위로 집계합니다. `rx`를 업로드, `tx`를 다운로드로 표시하는 방향은 기존 유선 인터넷·무선 LAN 관측에 근거하며, 모든 기기에서 별도로 검증한 값은 아닙니다. 공식 사이트 UUID와 내부 사이트 이름은 별도로 확인합니다.

범위를 추가로 확인하려는 경우 `MEASURE_CLIENT_IP` 또는 `MEASURE_CLIENT_MAC` 하나를 셸에 설정한 뒤 `pnpm --filter @utm/collector measure`로 원본 카운터를 읽을 수 있습니다. 아래 로컬 실행 절차처럼 `.env`의 UniFi 연결 설정과 `UNIFI_SITE_UUID`를 현재 셸에 로드하고, 전송을 시작하기 전에 첫 `baseline` 샘플이 출력될 때까지 기다립니다. 기본값은 20초 간격 12회이며 `MEASURE_SAMPLES`(2~60)와 `MEASURE_INTERVAL_MS`(5000~60000)로 조정할 수 있습니다. 출력은 원본 `rx`/`tx`의 샘플별 변화량과 품질을 JSON으로 표시하며 클라이언트 식별 정보는 출력하지 않습니다. 이 도구는 DB를 변경하지 않습니다. 인터넷/LAN 범위를 확정하려면 통제된 전송의 실측이 필요하지만, `reported` 범위 사용에는 이를 요구하지 않습니다.

## 로컬 실행

DB와 환경변수를 준비한 뒤 `.env`를 현재 셸에 로드합니다. Compose는 `--env-file`로 별도 로드합니다.

```sh
set -a; source .env; set +a
pnpm db:migrate
pnpm admin:create --email admin@example.com
pnpm dev
```

`admin:create`는 비밀번호를 대화형으로 입력받습니다. 공개 가입은 비활성화돼 있습니다. 앱은 기본 `http://localhost:3000`에서 실행합니다. 운영 시 `BETTER_AUTH_URL`은 실제 HTTPS 주소로 설정합니다.

## GHCR 이미지로 실행

`ghcr.io/aroxu/unifi-traffic-monitr:latest` 이미지는 GitHub Actions가 `main` 변경 시 `linux/amd64`와 `linux/arm64`로 게시합니다. 태그 `v*`를 푸시하면 동일한 버전 태그도 게시합니다. 이미지 안에 `.env`나 장비 인증 정보는 포함하지 않습니다.

```sh
cp .env.example .env
# .env에서 UTM_IMAGE=ghcr.io/aroxu/unifi-traffic-monitr:latest 및
# POSTGRES_PASSWORD, BETTER_AUTH_SECRET, BETTER_AUTH_URL,
# ADMIN_EMAIL, ADMIN_PASSWORD, UNIFI_URL, UNIFI_API_KEY,
# UNIFI_SITE, UNIFI_SITE_UUID를 채우세요.
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.ghcr.yaml --profile collector pull
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.ghcr.yaml --profile collector up -d db migrate bootstrap-admin web collector
```

관리자 이메일·비밀번호는 **빈 DB에 첫 계정을 만들 때만** 사용합니다. 기존 사용자가 있으면 건너뛰며, `.env`를 바꿔도 기존 비밀번호는 변경되지 않습니다. `UNIFI_URL`은 Network 앱의 HTTPS 주소이고 `UNIFI_API_KEY`는 collector에만 전달됩니다. `UNIFI_SITE_UUID`와 `UNIFI_SITE`도 같은 사이트를 가리켜야 합니다. `UNIFI_WIRED_SCOPE=reported`, `UNIFI_WIRED_RX_DIRECTION=upload`, `UNIFI_WIRELESS_SCOPE=reported`, `UNIFI_WIRELESS_RX_DIRECTION=upload`을 설정하면 API 보고 사용량을 표시합니다.

사설 CA를 쓰는 경우 CA 파일을 collector 컨테이너에 읽기 전용으로 마운트하고 `UNIFI_CA_FILE`에 컨테이너 안의 경로를 지정하세요. 이 호스트의 `deploy/compose.local.yaml`이 해당 예시입니다. 이미지가 비공개이면 GHCR에서 이미지를 받을 수 있는 계정의 `read:packages` 토큰으로 `docker login ghcr.io`를 먼저 실행해야 합니다.

Compose 사용 시 저장소 루트에서 `docker compose --env-file .env -f deploy/compose.yaml up -d db migrate web`로 시작합니다. 실장비 PoC와 사이트 매핑을 마친 뒤 `docker compose --env-file .env -f deploy/compose.yaml --profile collector up -d collector`를 실행합니다. `collector`는 클라이언트·장비 정보와 원본 카운터를 저장하며 UCG 자격 증명은 collector 서비스에만 전달됩니다.

이 호스트처럼 Docker 브리지 컨테이너에서 LAN으로 나가는 연결이 막히거나 웹 포트 3000이 이미 사용 중이면 로컬 오버라이드를 적용할 수 있습니다. DB는 Docker에 유지되고 호스트의 `127.0.0.1:5433`에만 공개됩니다. 웹은 `127.0.0.1:3001`에서 실행됩니다.

```sh
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.local.yaml --profile collector up -d --build db migrate web collector
```

Compose의 첫 실행은 `.env`의 `ADMIN_EMAIL`과 `ADMIN_PASSWORD`로 빈 DB에 관리자를 생성합니다. 이 호스트에는 로컬 관리자 계정이 이미 생성되어 있어 초기화 작업은 계정을 변경하지 않습니다. 자격 정보는 저장소 밖 또는 Git에서 제외한 로컬 파일에만 둡니다.

## 백업과 복원

`deploy/backup.sh`는 Docker PostgreSQL의 압축 덤프를 만들고 목차를 검증합니다. 기존 파일은 덮어쓰지 않으며 권한은 소유자 전용입니다.

```sh
./deploy/backup.sh ".local/traffic-$(date +%Y%m%d-%H%M%S).dump"
```

복원 시 웹과 수집기를 멈춘 뒤 해당 덤프를 PostgreSQL에 넣습니다. 다음 명령의 파일 경로를 실제 백업 파일로 바꿉니다. 복원은 현재 DB 내용을 백업 시점으로 되돌립니다. 동일 덤프의 빈 DB 복원과 `--clean` 재복원을 별도 임시 컨테이너에서 확인했습니다.

```sh
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.local.yaml --profile collector stop web collector
docker compose --env-file .env -f deploy/compose.yaml exec -T db \
  pg_restore --clean --if-exists --no-owner --no-privileges -U traffic -d traffic < .local/traffic-BACKUP.dump
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.local.yaml --profile collector up -d web collector
```

## 수집 관찰

`deploy/observe.sh`는 로컬 Compose PostgreSQL을 읽기 전용으로 조회합니다. 관찰 시작 시각부터 성공·오류 수집 횟수, 시작·끝 경계까지 포함한 최장 공백, 최신 성공 경과 시간, 샘플 수, DB 크기를 확인할 수 있습니다. 이 호스트의 24시간 관찰 기준은 2026-09-26 02:52 UTC입니다.

```sh
./deploy/observe.sh 2026-09-26T02:52:00Z
```

24시간 판정은 2026-09-27 02:52 UTC 이후에 같은 명령으로 확인합니다.

## 현재 제한

- 읽기 전용 `pnpm --filter @utm/unifi dpi:poc`은 내부 v2 DPI 앱 사용량의 클라이언트 수와 수신·송신 합계만 출력합니다. 실행 전에 `.env`를 환경으로 불러오고 `UNIFI_CA_FILE`을 실제 CA 경로로 지정한 뒤 `DPI_START`·`DPI_END`를 ISO 8601 시각으로 설정합니다. 최대 조회 범위는 24시간입니다. `DPI_CLIENT_MAC`을 주면 그 클라이언트만 조회하며 MAC은 출력하지 않습니다. 이 값의 기간 경계와 인터넷 전용 범위는 아직 검증되지 않았으므로 운영 집계에는 연결하지 않았습니다. 실측은 [POC_RESULTS.md](./POC_RESULTS.md)를 참고합니다.
- 실장비 `traffic-flows`의 완료 세션 기록은 출발지·목적지와 바이트를 제공하지만, 통제된 8 MB 인터넷 다운로드 두 차례에서 해당 클라이언트의 출발지 `outgoing` 흐름 합은 각각 약 0.62 MB와 0.33 MB에 그쳤습니다. 목적지 MAC 기준 흐름도 두 번째 시험에서 0건이었습니다. 이 로그를 정확한 인터넷 사용량으로 합산하지 않습니다. 기록 조건과 한계는 [POC_RESULTS.md](./POC_RESULTS.md)에 정리했습니다.
- 수집기는 유선·무선 원본 카운터를 정수로 저장하고 연결 세션·리셋에 따른 품질을 기록합니다. `reported` 매핑은 컨트롤러가 보고한 카운터의 정상 차분만 새 사용량 구간과 차트에 반영하며 인터넷/LAN 범위를 확정하지 않습니다.
- UniFi API 요청은 자동 리디렉션을 따르지 않습니다. 로그인 페이지 등으로 이동시키는 3xx 응답은 수집 오류로 기록해 API 키·쿠키가 다른 주소로 전달되지 않게 합니다.
- 무선 클라이언트 한 대의 직접 LAN ICMP/단방향 UDP 시험에서 원본 `tx_bytes`가 기기로 내려가는 트래픽과 함께 증가했고, `rx_bytes`는 반대 방향 응답과 함께 증가했습니다. 이 무선 원본을 인터넷 전용으로 표시할 수 없습니다. 무선 인터넷 전송과 유선 LAN 범위는 추가 검증이 필요합니다.
- 온라인 여부는 공식 연결 클라이언트 목록으로 판정합니다. 내부 통계 목록에만 남은 오프라인 클라이언트의 카운터는 새 사용량으로 기록하지 않으며, 재연결 후 첫 샘플은 기준값으로 처리합니다.
- 완전히 검증된 공식 연결 목록에서 클라이언트가 빠지면 그 수집 사이클에서 오프라인으로 전환하고 체크포인트를 지웁니다. 잠깐 끊겼다가 재연결한 첫 카운터도 새 기준값으로 처리합니다.
- 공식 연결 목록과 내부 통계의 유선/무선 유형이 어긋나면 해당 내부 카운터를 건너뛰고 기존 체크포인트를 지웁니다. 유형이 다시 일치한 첫 샘플은 새 기준값으로 처리합니다.
- 연결 장비가 바뀌면 내부 응답의 연결 시각이 그대로여도 그 클라이언트의 원본 카운터를 새 기준값으로 처리합니다. AP 로밍 전후의 바이트를 한 구간으로 합치지 않습니다.
- 무선 클라이언트 상세에는 컨트롤러가 보고한 마지막 `signal`·`noise`를 dBm으로 표시합니다. 연결이 끊기거나 내부 통계가 빠지면 값을 지웁니다. 원본 자체의 측정 시각은 없어 화면에는 수집 시각을 표시하며, 실시간 신호나 인터넷 사용량으로 해석하지 않습니다. [UniFi의 클라이언트 신호 단위 설명](https://help.ui.com/hc/en-us/articles/221321728-Understanding-and-Implementing-Minimum-RSSI)을 참고했습니다.
- 연결 방식별 `UNIFI_*_SCOPE=reported`와 `UNIFI_*_RX_DIRECTION=upload`를 함께 설정하면 API 카운터의 새 기준값을 잡고 이후 정상 차분을 `traffic_intervals`에 저장합니다. 과거 `unknown` 원본은 범위를 소급하여 추정하지 않습니다. 실제 범위를 확인한 경우에만 `internet`, `lan`, `combined`로 설정합니다.
- 내부 클라이언트 목록은 단일 응답에서 읽고 `meta.rc='ok'`를 요구합니다. 응답에 `count`나 `totalCount`가 있으면 배열 길이와 일치해야 합니다. 이 장비의 응답 메타데이터에는 `rc`만 있고 건수는 없습니다. `offset`·`start`·`page`와 `limit=1`을 조합한 읽기 전용 시험에서도 모두 기본 응답과 같은 44행을 반환해 해당 매개변수로는 페이지를 나눌 수 없었습니다. 같은 시각 공식 연결 목록 44대와 MAC 집합이 일치했습니다. 더 많은 클라이언트에서 서버 측 상한이 있는지는 확인되지 않았습니다.
- 검증된 구간은 UTC 5분·1시간 롤업에 바이트 합계를 보존합니다. 관측 시간은 수집 구간 전체를 한 번 초 단위로 반올림해 버킷에 나눕니다. 기본 보존 기간은 상세 구간·원본 7일, 5분 롤업 90일, 시간 롤업 365일입니다. 재집계가 필요한 이전 구간은 한 번만 반영하고, 롤업이 반영된 상세 구간만 정리합니다. 기간 조회는 버킷 양끝을 포함하므로 화면에 추정 범위를 안내합니다.
- 클라이언트 상세의 사용 가능한 범위는 관측 시간이 있는 롤업에서만 선택합니다. 백필을 기다리는 상세 구간만 존재할 때에는 차트가 읽을 수 없는 범위를 먼저 표시하지 않습니다.
- 동일 카운터의 수집 공백이 기본 10분(또는 설정한 수집 주기의 10배)을 넘으면 알 수 없는 전송량은 사용량에 더하지 않고 `gap`으로 기록합니다. 이후 첫 샘플을 새 기준값으로 사용합니다.
- PostgreSQL의 유휴 연결이 끊겨도 수집기 프로세스는 유지되고 다음 사이클에서 재연결합니다. 별도 시험 DB를 중단·복구해 재수집과 상세·롤업 합계 일치를 확인했습니다.
- 보존 기간은 `/settings`에서 변경할 수 있으며 `원본 ≤ 5분 ≤ 시간` 순서를 지켜야 합니다. 검증된 구간이 있는 환경에서는 개요의 24시간 차트·상위 클라이언트와 클라이언트 상세 기간 차트를 표시합니다. 실제 원본 관측 시간이 없어 버킷 내 전송 시각은 추정입니다.
- 개요의 사이트·클라이언트·최신 수집·원본 샘플·트래픽 조회는 하나의 PostgreSQL 읽기 스냅샷에서 처리해 수집 사이클이 조회 도중 커밋되어도 서로 다른 세대의 값을 섞지 않습니다.
- 개요의 원본 카운터 카드에는 공식 연결 클라이언트 중 해당 수집 회차에 원본 카운터가 없는 대수를 함께 표시합니다. 내부 통계 누락·연결 방식 불일치·미지원 등 원인은 이 숫자만으로 단정하지 않습니다.
- 백업/복원과 롤업·보존은 별도 PostgreSQL에서 시험했습니다. 24시간 실장비 관찰은 남아 있습니다. 유선 일반 LAN 범위와 무선 인터넷 범위는 검증하지 않았으며 운영의 `reported` 값을 인터넷 전용으로 표시하지 않습니다. 로그인→필터→상세 흐름의 데스크톱·모바일 Playwright 테스트는 통과했습니다.
