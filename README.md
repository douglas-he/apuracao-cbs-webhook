# Apuração CBS: cliente com webhook

Projeto simples em Node.js, sem dependências, para:

1. Você digitar **client_id** e **client_secret** numa página local. Eles **não são gravados**: ficam só na memória do processo e são apagados ao fim da solicitação.
2. Obter o token OAuth2 (`client_credentials`) e abrir a solicitação na Receita (débitos, créditos, pagamentos ou recolhimentos).
3. Receber o **webhook** (`urlRetorno`), confirmar a situação na API, pegar a `urlAssinada` e salvar o JSON em `resultados/`.

Referências: <https://docs.receitafederal.gov.br/apuracao-cbs/> e o manual técnico "Receita Integra" (SERPRO).

## Requisitos

- Node.js 18 ou mais novo (`node --version`).
- Um túnel HTTPS público para o webhook. A Receita precisa alcançar sua máquina pela internet. Opções:
  - **cloudflared** (grátis, sem conta): `winget install Cloudflare.cloudflared`
  - **ngrok**: <https://ngrok.com/download> (exige conta)
- Credenciais geradas no portal (serviço "Gerar Credencial para API"), **do estabelecimento matriz**.

## Como rodar

**1. Inicie o servidor** (na pasta do projeto):

```bash
npm start
```

Ele sobe duas portas:

| Porta | Uso | Expor? |
|---|---|---|
| `3000` | Página onde você digita as credenciais | **Nunca** |
| `3001` | Webhook `/webhooks/apuracao-cbs` | Sim, pelo túnel |

**2. Em outro terminal, abra o túnel apontando para a porta 3001:**

```bash
cloudflared tunnel --url http://localhost:3001
```

Copie a URL `https://xxxx.trycloudflare.com` que aparecer. Com ngrok: `ngrok http 3001`.

**3. Abra <http://localhost:3000>** e preencha:

- client_id e client_secret
- Ambiente: Produção, Produção restrita ou Homologação
- Consulta: `debitos`, `creditos`, `pagamentos` ou `recolhimentos`
- CNPJ da matriz (completo ou os 8 dígitos; só a base é enviada)
- URL pública do túnel (o caminho `/webhooks/apuracao-cbs` é adicionado automaticamente)

Clique em **Solicitar à Receita**. A página mostra a linha do tempo. Quando o webhook chegar com `CONCLUIDA`, o arquivo é salvo em `resultados/<api>-<cnpj>-<tiquete>.json` e as credenciais são apagadas.

> Deixe o servidor **e** o túnel rodando até o resultado chegar. A Receita pode levar até 240 minutos (depois disso a solicitação expira). Se o processo parar, as credenciais e o tíquete em memória se perdem; isso é proposital.

## Como funciona (fluxo da documentação)

```
POST https://api.receitafederal.gov.br/token          grant_type=client_credentials (Basic client_id:secret)
POST .../apuracao-cbs/v2/{api}/{cnpjBase}             {"urlRetorno": "https://.../webhooks/apuracao-cbs"}
     └─ Receita faz HEAD na urlRetorno → responde 200 → 201 {"tiqueteSolicitacao", "tEASegundos"}
… Receita processa …
POST (webhook) /webhooks/apuracao-cbs                 {"tiqueteSolicitacao", "situacao": "CONCLUIDA"}
GET  .../apuracao-cbs/v2/situacao/{tiquete}           confirma a situação (o webhook não é assinado)
GET  .../apuracao-cbs/v2/download/{tiquete}           {"urlAssinada", "urlAssinadaExpiraEm"}
GET  urlAssinada (sem Bearer)                         arquivo JSON → resultados/
```

Se o webhook não chegar, use **Consultar situação agora** na página (contingência prevista na documentação).

## Segurança

- Credenciais: só em memória, nunca em disco nem em log. O campo do segredo é limpo no navegador após o envio. Ficam apagadas ao baixar o resultado, em `ERRO`/`EXPIRADA`, após 4h10 ou ao clicar em **Descartar credenciais**.
- A página (porta 3000) escuta só em `127.0.0.1` e recusa `Host` diferente de localhost.
- Segundo o FAQ, o webhook da Receita **não tem assinatura nem autenticação**. Por isso o projeto nunca confia no conteúdo recebido: ele confirma a situação na API antes de baixar.
- Para aceitar só o IP da Receita (produção: `189.9.61.23`):

  ```powershell
  $env:WEBHOOK_ALLOWED_IPS="189.9.61.23"; npm start
  ```

- A `urlAssinada` é tratada como segredo e não vai para o log.
- `resultados/` contém dados fiscais e está no `.gitignore`.

## Variáveis de ambiente (opcionais)

| Variável | Padrão | Descrição |
|---|---|---|
| `UI_PORT` | `3000` | Porta da página local |
| `WEBHOOK_PORT` | `3001` | Porta do webhook (alvo do túnel) |
| `WEBHOOK_PATH` | `/webhooks/apuracao-cbs` | Caminho do webhook |
| `WEBHOOK_ALLOWED_IPS` | vazio | IPs aceitos no webhook, separados por vírgula. Vazio = aceita e só avisa |
| `TOKEN_AUTH_MODE` | `basic` | `basic` = `Authorization: Basic`; `body` = `client_id`/`client_secret` no corpo |
| `MOCK_URL` | vazio | Adiciona um ambiente "Simulado" para testes locais |
| `LOG_DIR` | `logs/` | Pasta dos arquivos de log |
| `RECEITA_TIMEOUT_MS` | `60000` | Tempo máximo de espera por resposta da Receita |

No PowerShell: `$env:TOKEN_AUTH_MODE="body"; npm start`.

## Logs: onde o processo parou

Cada chamada à Receita é registrada no terminal, em `logs/execucao-AAAA-MM-DD.log` e na linha do tempo da página, com a etapa, o método, a rota, o status HTTP, o tempo e a resposta em caso de erro.

| Etapa | Chamada |
|---|---|
| `1/7 TOKEN` | `POST /token` |
| `2/7 ABERTURA` | `POST /apuracao-cbs/v2/{api}/{cnpj}` (inclui o HEAD da Receita no webhook) |
| `3/7 WEBHOOK` | Receita → `POST` na sua `urlRetorno` |
| `4/7 SITUACAO` | `GET /situacao/{tiquete}` |
| `5/7 LINK` | `GET /download/{tiquete}` |
| `6/7 ARQUIVO` | `GET urlAssinada` (a query é ocultada no log) |
| `7/7 SALVAR` | grava em `resultados/` |

Quando algo falha, aparece uma linha `PROCESSO PAROU na etapa ...` seguida de uma `Dica`, e a página mostra um quadro vermelho com a etapa e a rota. Também são registrados os cabeçalhos de diagnóstico, se a Receita os enviar: `retry-after`, `x-ratelimit-*` e IDs de rastreio (`activityid`, `x-request-id`). Informe esses IDs num chamado.

Exemplo de falha:

```
INFO  [#2] [2/7 ABERTURA] -> POST https://api.receitafederal.gov.br/apuracao-cbs/v2/creditos/12345678 corpo={"urlRetorno":"..."}
ERRO  [#2] [2/7 ABERTURA] <- HTTP 403 em 180ms | activityid=... | resposta={"message":"You cannot consume this service"}
ERRO  [#2] PROCESSO PAROU na etapa 2/7 ABERTURA: ...
ERRO  [#2] Dica: token válido, mas a credencial não tem permissão para esta rota/ambiente. ...
```

Não aparecem nos logs: client_id, client_secret, o token, o cabeçalho `Authorization` e a assinatura da `urlAssinada`. A pasta `logs/` está no `.gitignore`.

Se nenhuma linha `[3/7 WEBHOOK]` aparecer depois de `Aguardando webhook`, a Receita ainda não avisou ou não conseguiu alcançar o túnel. Use **Consultar situação agora**.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `[1/7 TOKEN] ... HTTP 401` | Credencial errada ou ambiente errado. Tente `TOKEN_AUTH_MODE=body` |
| `[1/7 TOKEN] ... HTTP 429` | Limite de requisições do gateway. Aguarde (veja `retry-after` no log) |
| `[2/7 ABERTURA] ... HTTP 403 You cannot consume this service` | O token saiu, mas a credencial não tem permissão para essa rota ou ambiente. Teste o outro ambiente |
| `[2/7 ABERTURA] ... HTTP 400` mencionando a URL | O HEAD da Receita não alcançou o webhook: túnel parado, URL errada ou apontando para a porta 3000 |
| `falha de rede: ENOTFOUND / ECONNRESET / sem resposta` | Internet, proxy ou firewall corporativo bloqueando a saída |
| `HTTP 401 NAO_AUTORIZADO ... para este NI` | O CNPJ não é da matriz ligada à credencial |
| `HTTP 429` | Limite de **4 chamadas por dia por credencial e por API** (zera à meia-noite) |
| Homologação bloqueada | Esse ambiente exige que o seu IP de saída esteja liberado na ACL da Receita |
| `404 ARQUIVO_INDISPONIVEL` | Processamento não concluído ou arquivo já baixado |

## Pontos não confirmados na documentação

- **Formato do envio do client_id/secret ao token**: o manual diz apenas OAuth 2.0 `client_credentials` via POST. O padrão aqui é Basic (RFC 6749). Se falhar, use `TOKEN_AUTH_MODE=body`.
- **URL base da API em homologação**: o manual traz só o token (`h-api.receitafederal.gov.br/token`). O projeto supõe `https://h-api.receitafederal.gov.br/apuracao-cbs/v2`.
- **Produção restrita**: a documentação cita `apuracao-cbs-prr` só no endpoint de download. O projeto usa esse prefixo em todos os endpoints desse ambiente.
