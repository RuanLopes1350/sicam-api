# SICAM API — Sistema de Carta-Imagem e Análise Multitemporal

> **Núcleo geoespacial, orquestração assíncrona, cartografia 300 DPI e cadeia de custódia do ecossistema SICAM.**

O **SICAM** (*Sistema de Carta-Imagem e Análise Multitemporal*) é uma plataforma institucional de geoprocessamento voltada à detecção multitemporal de supressão florestal, degradação e regeneração vegetal a partir de imagens **Sentinel-2 L2A (COG)**.

Este repositório (`sicam-api`) contém o **backend oficial** do sistema: API REST/SSE em **Fastify 5 + TypeScript**, motor científico **`geo-core`**, workers assíncronos **BullMQ**, motor cartográfico offline (**Playwright Chromium** em 300 DPI) e persistência geodésica em **PostgreSQL 16 + PostGIS 3.4**.

> **Passo a passo técnico aprofundado:** para operar, integrar via HTTP (`curl`) e entender os detalhes internos de cada módulo, consulte o [**Guia Técnico Operacional Passo a Passo (`docs/GUIA_TECNICO_PASSO_A_PASSO.md`)**](./docs/GUIA_TECNICO_PASSO_A_PASSO.md).

---

## Sumário

- [1. Natureza do Projeto](#1-natureza-do-projeto)
- [2. Arquitetura e Funcionamento](#2-arquitetura-e-funcionamento)
  - [2.1 Arquitetura de Serviços e Dados](#21-arquitetura-de-serviços-e-dados)
  - [2.2 Camadas da Aplicação](#22-camadas-da-aplicação)
  - [2.3 Motor Científico `geo-core`](#23-motor-científico-geo-core)
  - [2.4 Motor Cartográfico Offline & Custódia `FROZEN`](#24-motor-cartográfico-offline--custódia-frozen)
- [3. Segurança Zero Trust e Governança](#3-segurança-zero-trust-e-governança)
- [4. Pré-requisitos e Variáveis de Ambiente](#4-pré-requisitos-e-variáveis-de-ambiente)
- [5. Como Executar e Utilizar](#5-como-executar-e-utilizar)
  - [5.1 Modo Híbrido (Infraestrutura Docker + API/Worker Locais)](#51-modo-híbrido-infraestrutura-docker--apiworker-locais)
  - [5.2 Modo Full-Docker (`Dockerfile` + `docker-compose.yml`)](#52-modo-full-docker-dockerfile--docker-composeyml)
  - [5.3 Reverse Proxy Traefik v3 (Perfil `edge`)](#53-reverse-proxy-traefik-v3-perfil-edge)
- [6. Scripts Disponíveis (`package.json`)](#6-scripts-disponíveis-packagejson)
- [7. Catálogo Resumido da API (`/api/v1`)](#7-catálogo-resumido-da-api-apiv1)
- [8. Testes Automatizados e Contrato OpenAPI](#8-testes-automatizados-e-contrato-openapi)

---

## 1. Natureza do Projeto

O SICAM foi projetado com requisitos estritos de **reprodutibilidade científica, auditabilidade pericial e isolamento Zero Trust**:

- **Geodésia Oficial Brasileira:** Todas as geometrias são armazenadas em **SIRGAS 2000 (`EPSG:4674`)**, com projeção dinâmica para o fuso **SIRGAS 2000 / UTM** correspondente ao centroide da Área de Interesse (AOI) para cálculo oficial de áreas em hectares e perímetros em metros.
- **Processamento sem Dependência de Desktop GIS:** A ingestão parcial de bandas COG (`B02`, `B03`, `B04`, `B08`, `SCL`) via HTTP Range Requests, o cálculo de $\Delta\text{NDVI}$, a vetorização e a emissão de pranchas cartográficas A4/A3 ocorrem integralmente no servidor.
- **Imutabilidade Forense (`FROZEN`):** Uma vez emitida a Carta-Imagem e o Pacote Técnico (`.zip`), triggers no PostgreSQL bloqueiam qualquer alteração em polígonos ou metadados daquela versão, selando o conjunto com hashes **SHA-256** e registro na trilha de auditoria *append-only*.
- **Arquitetura Polyrepo Desacoplada:** O `sicam-api` comunica-se exclusivamente com o `sicam-front` pelo contrato **OpenAPI 3.1.0** exportado em [`openapi/openapi.v1.json`](./openapi/openapi.v1.json).

---

## 2. Arquitetura e Funcionamento

### 2.1 Arquitetura de Serviços e Dados

```mermaid
flowchart LR
    Client["sicam-front / Cliente HTTP"] -->|"REST JSON + Bearer EdDSA + Cookie Refresh"| API["sicam-api (Fastify HTTP :3333)"]
    Client -->|"SSE Streaming (/events)"| API
    API -->|"Consultas Geodésicas / RBAC / Auditoria"| PG[("PostgreSQL 16 + PostGIS 3.4")]
    API -->|"Enfileiramento + Rate Limit + Idempotency + Pub/Sub"| Redis[("Redis 7 (noeviction)")]
    API -->|"Proxy Autenticado Raster / PDF / ZIP"| S3[("SeaweedFS S3 Privado :9000")]
    Redis -->|"Filas geo-analysis e cartography-export"| Worker["sicam-worker (geo-core + Playwright)"]
    Worker -->|"STAC + COG Range Requests (Anti-SSRF)"| STAC["AWS Earth Search / INPE BDC"]
    Worker -->|"Persistência Transacional + FROZEN"| PG
    Worker -->|"Upload PNG / PDF 300 DPI / ZIP"| S3
    Worker -->|"Eventos progress / ready_for_review / frozen"| Redis
```

### 2.2 Camadas da Aplicação

O código em `src/` segue separação estrita de responsabilidades:

| Camada | Diretório | Responsabilidade |
| :--- | :--- | :--- |
| **Routes** | `src/routes/` | Definição das rotas `/api/v1/*`, rate-limiting, `requireAuth` (RBAC) e schemas Zod para geração do OpenAPI 3.1. |
| **Controller** | `src/controller/` | Extrai parâmetros, cabeçalhos (`Idempotency-Key`), cookies e `req.user`, delegando ao Service sem regra de negócio. |
| **Service** | `src/service/` | Validação estrita com Zod, regras de negócio, proteção Anti-SSRF, cálculo de sazonalidade e controle transacional. |
| **Repository** | `src/repository/` | Acesso ao PostgreSQL (`pg` + SQL geodésico/Drizzle), Redis (`ioredis` + Pub/Sub) e SeaweedFS S3 (`@aws-sdk/client-s3`). |
| **Geo / Cartography** | `src/utils/geo/` | Motor científico `geo-core` (análise Sentinel-2) e pipeline cartográfico 300 DPI + empacotamento determinístico. |
| **Workers** | `src/workers/` | Consumidores BullMQ das filas `geo-analysis` e `cartography-export` executados pelo entrypoint `src/worker.ts`. |

### 2.3 Motor Científico `geo-core`

Implementado em `src/utils/geo/core/` (`GEO_CORE_ENGINE_VERSION = 'sicam-geo-core/1.0.0'`):

1. **Descoberta STAC & Medição Real de Nuvens (`POST /cases/:caseId/scenes/search`):**
   - Consulta os provedores whitelisted (`aws_earth_search` e `inpe_bdc`) em janelas de até 180 dias.
   - Agrupa cenas de múltiplos tiles MGRS da mesma data e lê parcialmente a banda `SCL` (*Scene Classification Layer*) via **HTTP Range Request** apenas dentro da AOI para medir `% nuvem real na AOI` e `% cobertura`.
   - Aplica harmonização radiométrica **BOA_ADD_OFFSET (`-1000` DN)** quando aplicável (Baseline Sentinel-2 >= `04.00`).
2. **Grade Canônica UTM (`canonicalGrid.ts`):**
   - Constrói grade uniforme de **10 m × 10 m** no fuso UTM oficial da AOI (com guarda de memória `GEO_MAX_PIXELS_GUARD`, padrão `8.000.000` pixels).
3. **Classificação $\Delta\text{NDVI}$ + Máscara `SCL` (`ndviClassifier.ts`):**
   - Calcula $\text{NDVI}_{T_0}$, $\text{NDVI}_{T_1}$ e $\Delta\text{NDVI} = \text{NDVI}_{T_1} - \text{NDVI}_{T_0}$, aplicando máscara de nuvens/sombras/água da banda `SCL` e os limiares do preset (`TECHNICAL_STANDARD`, `CONSERVATIVE` ou `CUSTOM` validado contra `ANALYSIS_HARD_BOUNDS`).
4. **Filtragem Morfológica & Vetorização (`morphology.ts`, `connectedComponents.ts`, `vectorizer.ts`):**
   - Aplica abertura morfológica $3\times 3$ em cruz (`morphologicalKernel`), extrai componentes conexos 8-vizinhos acima da Unidade Mínima de Mapeamento (`minMappingUnitHa`), vetoriza polígonos com simplificação topológica (`5.0 m`) e renderiza 5 evidências PNG lossless (`t0_rgb`, `t1_rgb`, `t0_false_color`, `t1_false_color`, `delta_ndvi_mask`).

### 2.4 Motor Cartográfico Offline & Custódia `FROZEN`

Implementado em `src/utils/geo/cartography/` e acionado na fila `cartography-export`:

- **Prancha Cartográfica 300 DPI (`pdfRenderer.ts`):** Renderiza HTML/SVG autocontido (grade de coordenadas UTM e geográficas, mapa principal em escala automática `scaleAndLayout.ts`, mapas comparativos $T_0/T_1$, legenda, resumo de áreas, QR Code de verificação e metadados do emissor) no **Playwright Chromium em modo `offline: true`** com bloqueio de toda URL que não seja `data:` ou `about:`.
- **Pacote Técnico Determinístico `.zip` (`technicalPackagePipeline.ts`):** Empacota 16 arquivos padronizados:
  - `01_carta_imagem_comparativa.pdf`
  - `02_relatorio_poligonos.csv` (protegido contra *CSV Formula Injection*)
  - `03_vetores/aoi.{geojson,kml}` e `03_vetores/{desmatamento,degradacao,regeneracao}.{geojson,kml}`
  - `04_rasters_evidencia/{t0_rgb,t1_rgb,t0_false_color,t1_false_color,delta_ndvi_mask}.png`
  - `05_manifesto_auditoria.json` (com `datasetFingerprintSha256` e lista completa de hashes).
- **Congelamento (`FROZEN`):** A transação persiste `export_packages`, muda o status da execução para `frozen` e ativa o bloqueio imutável via trigger SQL.

---

## 3. Segurança Zero Trust e Governança

- **Autenticação Assimétrica EdDSA (Ed25519):** Access Tokens JWT de curta duração (`ACCESS_TOKEN_TTL_SECONDS=900`, 15 min) assinados com Ed25519; senhas armazenadas com **Argon2id** (`@node-rs/argon2`).
- **Refresh Token Rotativo `HttpOnly`:** Armazenado em cookie `HttpOnly` com rastreamento de família e revogação imediata de toda a família em caso de detecção de reuso (*replay*).
- **RBAC Estrito:** Três perfis (`admin`, `analyst`, `auditor`) aplicados por rota em `requireAuth([...])`.
- **Segregação de Privilégios no PostgreSQL (*Least Privilege*):** O usuário `app_migrator` executa DDL/migrations (`0001`..`0012`), enquanto `app_runtime` possui apenas acesso DML às tabelas de aplicação (`0012_least_privilege_grants.sql`).
- **Bucket S3 Privado & Proxy Autenticado:** SeaweedFS opera sem identidade anônima (`infra/seaweedfs/s3.json`); o download de rasters, miniaturas e pacotes passa sempre pela API autenticada e auditada.
- **Barreira Anti-SSRF (`src/utils/helpers/antiSsrfHttp.ts`):** Todas as requisições STAC/COG externas exigem `https://` na porta `443`, domínio explícito em `STAC_WHITELISTED_HOSTS`, resolução DNS verificada contra IPs privados/loopback/link-local (`169.254.x.x`) e verificação em todos os redirecionamentos, além de *Circuit Breaker* por provedor.
- **Sem Segredos na URL:** O streaming SSE (`/api/v1/runs/:runId/events`) exige cabeçalho `Authorization: Bearer` e rejeita parâmetros extras em query string.

---

## 4. Pré-requisitos e Variáveis de Ambiente

- **Node.js `>= 22.0.0`** e **pnpm `9.7.0`** (via Corepack) para execução local
- **Docker Engine** e **Docker Compose** (v2+) para PostgreSQL/PostGIS, Redis, SeaweedFS S3 (ou stack containerizada completa)

Copie `.env.example` para `.env` na raiz do `sicam-api`:

```bash
cp .env.example .env
```

Principais variáveis definidas em `src/config/env.ts` e `.env.example`:

| Variável | Padrão (`.env.example` / Dev) | Descrição |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | `development`, `test` ou `production`. Em `production`, força `COOKIE_SECURE=true`, desabilita `/docs/openapi.json` e exige chaves JWT Ed25519. |
| `HOST` / `PORT` | `0.0.0.0` / `3333` | Endereço e porta do servidor HTTP Fastify. |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | Origem permitida em CORS com `credentials: true`. |
| `ENABLE_OPENAPI_ROUTE` | `true` | Expõe `GET /docs/openapi.json` fora de produção. |
| `DATABASE_MIGRATOR_URL` | `postgresql://app_migrator:migrator_dev_secret@localhost:5432/sicam` | Conexão privilegiada usada apenas por `pnpm db:migrate`. |
| `DATABASE_URL` | `postgresql://app_runtime:runtime_dev_secret@localhost:5432/sicam` | Conexão *least-privilege* usada pela API e Workers. |
| `REDIS_URL` | `redis://localhost:6379` | Redis 7 com `noeviction` para BullMQ, Pub/Sub SSE, Rate Limit e `Idempotency-Key`. |
| `S3_ENDPOINT` / `S3_BUCKET` | `http://localhost:9000` / `sicam-artifacts` | SeaweedFS S3 privado (`S3_FORCE_PATH_STYLE=true`). |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `sicam_s3_admin` / `sicam_s3_dev_secret_key` | Credenciais S3 definidas em `infra/seaweedfs/s3.json`. |
| `JWT_ED25519_PRIVATE_KEY_B64` / `PUBLIC_KEY_B64` | *(vazio em dev)* | Par PEM PKCS#8/SPKI Ed25519 codificado em Base64 (obrigatório em `production`; gerado em memória em `development`). |
| `MIN_AOI_AREA_HA` / `MAX_AOI_AREA_HA` | `0.5` / `50000` | Limites operacionais de área da AOI em hectares. |
| `MAX_AOI_VERTICES` | `500` | Máximo de vértices do anel da AOI. |
| `MAX_ACTIVE_RUNS_PER_USER` | `2` | Limite de execuções simultâneas por analista. |
| `ENFORCE_IMPORTED_UF_COVERAGE` | `true` | Exige que o centroide/extensão da AOI intercepte UF carregada do IBGE. |
| `GEO_MAX_PIXELS_GUARD` | `8000000` | Teto de pixels da grade canônica UTM de 10 m por análise. |

---

## 5. Como Executar e Utilizar

### 5.1 Modo Híbrido (Infraestrutura Docker + API/Worker Locais)

Fluxo recomendado para desenvolvimento e depuração local:

```bash
# 1. Instalar dependências
corepack enable
pnpm install --frozen-lockfile

# 2. Subir PostgreSQL+PostGIS, Redis e SeaweedFS S3
docker compose up -d

# 3. Configurar .env e aplicar as 12 migrations SQL
cp .env.example .env
pnpm db:migrate

# 4. Importar malha oficial de municípios do IBGE (ex.: Rondônia) e popular usuários iniciais
pnpm ibge:import -- --uf=RO
pnpm db:seed

# 5. Em dois terminais, iniciar a API HTTP e o Worker dedicado
pnpm dev
pnpm worker:dev
```

Verifique a disponibilidade em `http://localhost:3333/api/v1/health/ready` e o contrato OpenAPI em `http://localhost:3333/docs/openapi.json`.

### 5.2 Modo Full-Docker (`Dockerfile` + `docker-compose.yml`)

O repositório fornece um `Dockerfile` multi-stage baseado em `node:22-bookworm-slim` com dois targets:
- **`api`:** imagem enxuta apenas com runtime da API HTTP e migrations (`dist/server.js`), usuário não-root `sicam` e `HEALTHCHECK` em `/api/v1/health/live`.
- **`worker`:** estende `api` instalando Chromium + dependências e fontes Linux (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`) para o motor cartográfico 300 DPI (`dist/worker.js`).

Para subir toda a stack (`postgres`, `redis`, `s3`, `migrator`, `api` e `worker`):

```bash
docker compose --profile full up -d --build
```

Para executar a importação IBGE e o seed dentro do container `api` já no ar:

```bash
docker compose exec api node dist/scripts/ibgeImport.cli.js --uf=RO
docker compose exec api node dist/seeds/index.js
```

> **Nota para produção:** ao executar com `NODE_ENV=production`, forneça `JWT_ED25519_PRIVATE_KEY_B64` e `JWT_ED25519_PUBLIC_KEY_B64` no `.env` antes de subir os containers.

### 5.3 Reverse Proxy Traefik v3 (Perfil `edge`)

O serviço opcional `traefik` (`infra/traefik/dynamic.yml`) publica na porta `8080` o roteamento unificado `/api` -> `sicam-api (:3333)` (com `sse-transport` sem timeout e `flushInterval: 100ms` para SSE) e `/` -> `sicam-front (:5173)`:

```bash
docker compose --profile edge up -d traefik
```

---

## 6. Scripts Disponíveis (`package.json`)

| Comando | Ação |
| :--- | :--- |
| `pnpm dev` | Inicia o servidor Fastify em modo watch (`tsx watch src/server.ts`). |
| `pnpm worker:dev` | Inicia os workers BullMQ (`geo-analysis` + `cartography-export`) em modo watch. |
| `pnpm build` | Compila TypeScript para `./dist` usando `tsconfig.build.json`. |
| `pnpm start` | Executa a API compilada (`node dist/server.js`). |
| `pnpm worker` | Executa os workers compilados (`node dist/worker.js`). |
| `pnpm typecheck` | Verificação estrita de tipos (`tsc --noEmit`). |
| `pnpm test` | Executa toda a suíte Vitest (`vitest run`). |
| `pnpm test:coverage` | Executa a suíte com relatório de cobertura V8 (`vitest run --coverage`). |
| `pnpm db:migrate` | Aplica sequencialmente as migrations `0001`..`0012` usando `DATABASE_MIGRATOR_URL`. |
| `pnpm db:seed` | Cria os operadores iniciais (`admin`, `analyst`, `auditor`) de forma idempotente. |
| `pnpm ibge:import -- --uf=RO` | Importa malha oficial estadual e municipal da API de Malhas do IBGE v3 para o PostGIS. |
| `pnpm openapi:export` | Exporta `openapi/openapi.v1.json` em modo `dryRun` (sem conectar em DB/Redis). |

---

## 7. Catálogo Resumido da API (`/api/v1`)

| Domínio | Endpoints | Perfis Autorizados |
| :--- | :--- | :--- |
| **System** | `GET /health/live`, `GET /health/ready`, `GET /system/capabilities` | Público (health) / Autenticado (`capabilities`) |
| **Auth** | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` | Público (`login`/`refresh`) / Autenticado (`logout`/`me`) |
| **Users** | `GET /users`, `POST /users`, `PATCH /users/:userId` | `admin` |
| **Territories** | `GET /territories/states`, `GET /territories/municipalities` | `admin`, `analyst`, `auditor` |
| **Cases** | `POST /cases`, `GET /cases`, `GET /cases/:caseId`, `PATCH /cases/:caseId` | `analyst` (escrita) / Todos autenticados (leitura) |
| **Scenes** | `POST /cases/:caseId/scenes/search`, `GET /cases/:caseId/scenes/preview` | `analyst` (`search`) / Todos autenticados (`preview`) |
| **Runs** | `POST /cases/:caseId/runs`, `GET /runs/:runId`, `GET /runs/:runId/events` (SSE), `GET /runs/:runId/features`, `PATCH /runs/:runId/features/:featureId/review`, `GET /runs/:runId/rasters/:assetType` | `analyst` (criar/revisar) / Todos autenticados (consulta/SSE/raster) |
| **Exports & Integrity** | `POST /runs/:runId/export`, `GET /runs/:runId/export`, `GET /exports/:exportId/download`, `POST /integrity/verify` | `analyst` (solicitar export) / Todos autenticados (metadados/download/verificação) |
| **Audit** | `GET /audit-logs` (paginação keyset por `cursorSeqId`) | `admin`, `auditor` |

---

## 8. Testes Automatizados e Contrato OpenAPI

Para validar tipos, build e testes unitários/integração do backend:

```bash
pnpm typecheck && pnpm build && pnpm test
```

Sempre que alterar schemas Zod ou rotas da API, atualize o contrato OpenAPI antes de sincronizar o frontend (`sicam-front`):

```bash
pnpm openapi:export
```
