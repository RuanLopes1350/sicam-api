# Guia Técnico Operacional Passo a Passo — `sicam-api`

Este guia detalha, em ordem cronológica e com foco em engenharia e operação, **como o `sicam-api` funciona internamente** e **como executar o fluxo completo ponta a ponta** — desde o provisionamento da infraestrutura até a emissão de uma Carta-Imagem `FROZEN` e sua verificação criptográfica SHA-256.

---

## Etapa 1 — Provisionar Credenciais e Variáveis de Ambiente

1. Crie o arquivo `.env` a partir de `.env.example`:

```bash
cp .env.example .env
```

2. **Chaves Ed25519 para JWT (`NODE_ENV=production`):**
   - Em `development` ou `test`, `src/config/env.ts` gera um par Ed25519 efêmero em memória caso `JWT_ED25519_PRIVATE_KEY_B64` e `JWT_ED25519_PUBLIC_KEY_B64` estejam vazios (atenção: reiniciar a API invalida tokens antigos nesse modo).
   - Em `production`, `src/config/env.ts` exige explicitamente o par PKCS#8/SPKI codificado em Base64:

```bash
node -e '
const { generateKeyPairSync } = require("node:crypto");
const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
console.log("JWT_ED25519_PRIVATE_KEY_B64=" + Buffer.from(privateKey).toString("base64"));
console.log("JWT_ED25519_PUBLIC_KEY_B64=" + Buffer.from(publicKey).toString("base64"));
'
```

---

## Etapa 2 — Subir Infraestrutura Base e Verificar Healthchecks

Suba PostgreSQL/PostGIS, Redis 7 e SeaweedFS S3:

```bash
docker compose up -d
docker compose ps
```

O que acontece no boot dos containers:
- **`sicam-postgres` (`postgis/postgis:16-3.4-alpine`):** executa `infra/postgres/init-roles.sql` criando duas roles distintas:
  - `app_migrator` (dono do banco `sicam`, permissão DDL)
  - `app_runtime` (`NOSUPERUSER NOCREATEDB NOCREATEROLE`, sem privilégios administrativos)
  e habilita as extensões `postgis` e `pgcrypto`.
- **`sicam-redis` (`redis:7-alpine`):** inicia com `--appendonly yes` e `--maxmemory-policy noeviction` (requisito obrigatório do BullMQ para nunca descartar chaves de fila/locks).
- **`sicam-s3` (`chrislusf/seaweedfs`):** sobe o S3 Gateway na porta `9000` usando exclusivamente a identidade autenticada de `infra/seaweedfs/s3.json` (sem acesso anônimo). Ao iniciar a API (`src/server.ts`) ou o worker (`src/worker.ts`), a função `ensurePrivateBucket()` garante que o bucket `S3_BUCKET` existe.

---

## Etapa 3 — Executar as Migrations SQL (*Least Privilege*)

```bash
pnpm db:migrate
```

**Funcionamento interno (`src/config/db/migrate.ts`):**
- Conecta utilizando `DATABASE_MIGRATOR_URL` (`app_migrator`).
- Mantém a tabela de controle `_sicam_migrations` com o hash SHA-256 de cada arquivo em `drizzle/migrations/`:
  - `0001_extensions_and_enums.sql`..`0009_audit_logs.sql`: extensões, tipos enum e tabelas (`users`, `refresh_tokens`, `ibge_territories`, `analysis_cases`, `analysis_runs`, `detected_features`, `run_raster_assets`, `export_packages`, `audit_logs`).
  - `0010_immutability_and_geo_triggers.sql`: triggers que garantem imutabilidade da AOI após criação, bloqueio de edição quando `status = 'frozen'` e natureza *append-only* da tabela `audit_logs`.
  - `0011_indexes.sql`: índices espaciais GiST e índices compostos de busca/auditoria.
  - `0012_least_privilege_grants.sql`: concede à role `app_runtime` apenas as permissões DML mínimas necessárias.
- Se um arquivo já aplicado tiver seu SQL alterado manualmente, a execução falha propositalmente por divergência de checksum SHA-256.

---

## Etapa 4 — Importar Malha Oficial do IBGE e Criar Operadores Iniciais

1. **Importar UF e municípios do IBGE (`pnpm ibge:import`):**

```bash
pnpm ibge:import -- --uf=RO
```

O script `src/scripts/ibgeImport.cli.ts` consulta a API oficial de Malhas do IBGE v3, persiste geometrias em `EPSG:4674` na tabela territorial e calcula centróides/bounding boxes utilizados na validação de cobertura estadual (`ENFORCE_IMPORTED_UF_COVERAGE=true`) e na interseção automática de municípios ao criar casos.

2. **Popular operadores iniciais (`pnpm db:seed`):**

```bash
pnpm db:seed
```

Cria de forma idempotente três usuários com hash **Argon2id** (configuráveis via `SEED_ADMIN_PASSWORD`, `SEED_ANALYST_PASSWORD` e `SEED_AUDITOR_PASSWORD`, ou usando os padrões de desenvolvimento definidos em `src/seeds/index.ts`):
- `admin@sicam.gov.br` (`ADM-0001`, papel `admin`) — padrão `Sicam@Admin2026!`
- `analista@sicam.gov.br` (`ANA-0001`, papel `analyst`) — padrão `Sicam@Analista2026!`
- `auditor@sicam.gov.br` (`AUD-0001`, papel `auditor`) — padrão `Sicam@Auditor2026!`

---

## Etapa 5 — Iniciar API HTTP e Worker Dedicado

Em dois terminais separados (ou via `docker compose --profile full up -d --build`):

```bash
# Terminal 1 — Servidor HTTP Fastify (:3333)
pnpm dev

# Terminal 2 — Workers BullMQ (geo-analysis [concorrência 2] + cartography-export [concorrência 1])
pnpm worker:dev
```

Teste as sondas operacionais:

```bash
curl -s http://localhost:3333/api/v1/health/live
curl -s http://localhost:3333/api/v1/health/ready
```

---

## Etapa 6 — Fluxo Completo via API (Autenticação -> Análise -> Exportação `FROZEN`)

### 6.1 Autenticação EdDSA + Refresh Token `HttpOnly`

```bash
curl -i -c cookies.txt -X POST http://localhost:3333/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"analista@sicam.gov.br","password":"Sicam@Analista2026!"}'
```

- A resposta retorna `{ accessToken, expiresInSeconds: 900, user }` e define o cookie `HttpOnly` de Refresh Token.
- Guarde o token em variável de ambiente da sessão shell:

```bash
export TOKEN="<ACCESS_TOKEN_RETORNADO>"
```

- **Rotação de Refresh:** `POST /api/v1/auth/refresh` (enviando o cookie) invalida o token anterior da família e emite um novo par; reutilizar um token já consumido revoga toda a família por segurança.
- **Sair:** `POST /api/v1/auth/logout` com `Authorization: Bearer $TOKEN` revoga a sessão no PostgreSQL e limpa o cookie.

### 6.2 Capacidades Ativas e Malha Territorial

```bash
curl -s http://localhost:3333/api/v1/system/capabilities \
  -H "Authorization: Bearer $TOKEN"

curl -s "http://localhost:3333/api/v1/territories/municipalities?uf=RO&q=Porto" \
  -H "Authorization: Bearer $TOKEN"
```

`/system/capabilities` expõe os limites ativos (`minAreaHa`, `maxAreaHa`, `maxVertices`, `maxActiveRunsPerUser`), UFs carregadas (`loadedUfs`), presets homologados (`TECHNICAL_STANDARD`, `CONSERVATIVE`), `hardBounds` para o modo `CUSTOM` e formatos de papel suportados (`A4`, `A3`).

### 6.3 Provisionar Operadores (`admin` apenas)

Autenticado com token de `admin` (`admin@sicam.gov.br`):

```bash
curl -s -X POST http://localhost:3333/api/v1/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "Operador Geotecnologia",
    "registrationCode": "ANA-0042",
    "email": "operador42@sicam.gov.br",
    "password": "SenhaForteCom12+Chars!",
    "role": "analyst"
  }'
```

Ao desativar via `PATCH /api/v1/users/:userId` (`{"active": false}`), todos os Refresh Tokens do operador são revogados na mesma transação.

### 6.4 Criar Caso e Validar AOI em PostGIS (`EPSG:4674`)

Apenas `analyst` pode criar e editar metadados de casos:

```bash
curl -s -X POST http://localhost:3333/api/v1/cases \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Monitoramento Gleba Norte - Protocolo Teste",
    "externalRef": "PROC-2026/001",
    "description": "Verificação multitemporal Sentinel-2 L2A.",
    "aoiGeoJson": {
      "type": "Polygon",
      "coordinates": [[
        [-63.92, -8.78],
        [-63.88, -8.78],
        [-63.88, -8.74],
        [-63.92, -8.74],
        [-63.92, -8.78]
      ]]
    }
  }'
```

Internamente, o PostgreSQL/PostGIS:
1. Valida topologia (sem auto-interseção, polígono fechado, `<= MAX_AOI_VERTICES`);
2. Determina o `utmSrid` ideal a partir do centroide;
3. Calcula `aoiAreaHa` e `aoiPerimeterM` geodésicos e verifica `MIN_AOI_AREA_HA <= aoiAreaHa <= MAX_AOI_AREA_HA`;
4. Calcula interseção percentual com municípios do IBGE (`intersectedMunicipalities`) e gera `protocolCode` único.

### 6.5 Busca STAC Anti-SSRF & % Nuvem Real na AOI

```bash
export CASE_ID="<ID_DO_CASO>"

curl -s -X POST "http://localhost:3333/api/v1/cases/$CASE_ID/scenes/search" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "t0Window": { "from": "2024-06-01", "to": "2024-08-31" },
    "t1Window": { "from": "2025-06-01", "to": "2025-08-31" },
    "providers": ["aws_earth_search", "inpe_bdc"],
    "maxGlobalCloudPct": 40,
    "limitPerWindow": 15
  }'
```

- Cada janela respeita o limite máximo de 180 dias.
- O serviço verifica cada URL contra `STAC_WHITELISTED_HOSTS`, realiza leitura parcial HTTP Range da banda `SCL` dentro da AOI para calcular `aoiCloudPct` e `aoiCoveragePct`, e devolve `previewUrl` assinada para proxy seguro via `GET /api/v1/cases/:caseId/scenes/preview?token=...`.

### 6.6 Disparar Análise Assíncrona (`Idempotency-Key`) + Streaming SSE

1. Envie `POST /api/v1/cases/:caseId/runs` com cabeçalho obrigatório `Idempotency-Key` (UUID v4):

```bash
export IDEM_KEY=$(node -e "console.log(require('node:crypto').randomUUID())")

curl -s -X POST "http://localhost:3333/api/v1/cases/$CASE_ID/runs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $IDEM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "t0": { "provider": "aws_earth_search", "collection": "sentinel-2-l2a", "itemIds": ["<T0_ITEM_ID>"] },
    "t1": { "provider": "aws_earth_search", "collection": "sentinel-2-l2a", "itemIds": ["<T1_ITEM_ID>"] },
    "presetName": "TECHNICAL_STANDARD",
    "customParams": null
  }'
```

- Retorna HTTP `202 Accepted` com `{ runId, caseId, version, status: "queued", seasonalityWarning, eventsUrl }`.
- Caso a diferença entre `t0` e `t1` supere 60 dias dentro do ciclo sazonal anual, `seasonalityWarning: true` é gravado na execução e no manifesto.

2. Conecte-se ao stream SSE usando cabeçalho `Authorization: Bearer` (**sem token na URL**):

```bash
export RUN_ID="<RUN_ID_RETORNADO>"

curl -N http://localhost:3333/api/v1/runs/$RUN_ID/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: text/event-stream"
```

Eventos emitidos pelo canal Redis Pub/Sub + heartbeat de 15 s:
- `event: snapshot` — estado atual imediato ao conectar;
- `event: progress` — avanços do worker (`fetching_bands` 25%, `processing_ndvi` 60%, `vectorizing` 85%);
- `event: run.ready_for_review` — análise concluída com resumo geodésico;
- `event: run.failed` — falha terminal com `errorCode` e mensagem sanitizada.

### 6.7 Inspeção de Rasters, Polígonos e Curadoria Humana Auditável

- **Rasters PNG lossless (via SeaweedFS privado):**
  `GET /api/v1/runs/:runId/rasters/:assetType`, onde `:assetType` pertence a `t0_rgb`, `t1_rgb`, `t0_false_color`, `t1_false_color`, `delta_ndvi_mask`.
- **Polígonos vetorizados ordenados por área decrescente:**
  `GET /api/v1/runs/:runId/features?format=geojson` (ou `format=json&page=1&limit=100`).
- **Descartar ou reativar polígono (`analyst` apenas):**

```bash
curl -s -X PATCH "http://localhost:3333/api/v1/runs/$RUN_ID/features/$FEATURE_ID/review" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reviewStatus": "dismissed_noise",
    "dismissalReason": "Sombra topográfica próxima à borda da nuvem residual em T1."
  }'
```

A transação recalcula no PostGIS os totais consolidados (`deforestationHa`, `degradationHa`, `regrowthHa`, `activeFeatureCount`, `dismissedFeatureCount`) ignorando feições `dismissed_noise`, e grava evento de auditoria.

### 6.8 Emitir Carta-Imagem 300 DPI + Pacote Técnico `.zip` (`FROZEN`)

```bash
export EXPORT_IDEM=$(node -e "console.log(require('node:crypto').randomUUID())")

curl -s -X POST "http://localhost:3333/api/v1/runs/$RUN_ID/export" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $EXPORT_IDEM" \
  -H "Content-Type: application/json" \
  -d '{
    "paperFormat": "A3",
    "observations": "Emissão técnica para instrução processual."
  }'
```

- A fila `cartography-export` executa o pipeline de empacotamento (`25% -> 45% -> 65% -> 88%`), renderiza o PDF A3/A4 em Chromium offline (`blockedRequests` monitorado) e congela a execução (`event: export.frozen`).
- Consulte metadados e `auditManifest` em `GET /api/v1/runs/:runId/export`.
- Baixe os artefatos com registro obrigatório de auditoria `export_downloaded`:
  - `GET /api/v1/exports/:exportId/download?artifact=pdf`
  - `GET /api/v1/exports/:exportId/download?artifact=zip`
- Para testar novas combinações de cenas ou presets após o congelamento, dispare uma nova execução (`POST /cases/:caseId/runs`): o banco incrementa automaticamente `version` (`v2`, `v3`, ...).

### 6.9 Verificação Forense SHA-256 e Trilha de Auditoria

- **Modo 1 — Verificação por Hash JSON (64 hex):**

```bash
curl -s -X POST http://localhost:3333/api/v1/integrity/verify \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sha256":"<64_CARACTERES_HEX_DO_PDF_OU_ZIP>"}'
```

- **Modo 2 — Upload em Streaming (`multipart/form-data` até 100 MB):**

```bash
curl -s -X POST http://localhost:3333/api/v1/integrity/verify \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./01_carta_imagem_comparativa.pdf"
```

- **Consulta Keyset da Trilha de Auditoria (`admin` ou `auditor`):**

```bash
curl -s "http://localhost:3333/api/v1/audit-logs?limit=50" \
  -H "Authorization: Bearer $ADMIN_OR_AUDITOR_TOKEN"
```

---

## Etapa 7 — Manutenção do Contrato OpenAPI com o Frontend

Sempre que houver atualização nas rotas ou schemas Zod:

```bash
# No sicam-api:
pnpm openapi:export

# Em seguida, no sicam-front:
pnpm api:sync
```

Esse fluxo mantém `sicam-api/openapi/openapi.v1.json`, `sicam-front/openapi/openapi.v1.json` e `sicam-front/src/types/generated/openapi.d.ts` sincronizados com tipagem estrita ponta a ponta.
