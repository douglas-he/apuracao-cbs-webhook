// Cliente simples da API de Apuração CBS (Receita Federal) com webhook.
// Documentação: https://docs.receitafederal.gov.br/apuracao-cbs/
// Autenticação: manual "Receita Integra" (SERPRO) — OAuth 2.0 client_credentials.
//
// Dois servidores HTTP:
//   - Interface (UI) em 127.0.0.1:UI_PORT  -> onde você digita client_id/secret. NUNCA exponha.
//   - Webhook em 127.0.0.1:WEBHOOK_PORT     -> só esta porta vai para o túnel HTTPS público.
//
// client_id e client_secret ficam APENAS em memória, presos à solicitação, e são
// apagados quando o resultado é baixado, quando a solicitação falha/expira ou
// quando você clica em "Descartar". Nada de credencial, token ou urlAssinada vai para log.
//
// Etapas registradas nos logs (console, logs/execucao-AAAA-MM-DD.log e página):
//   1/7 TOKEN        POST {token}
//   2/7 ABERTURA     POST {base}/{api}/{cnpj}   (a Receita faz HEAD na urlRetorno durante esta etapa)
//   3/7 WEBHOOK      Receita -> POST na urlRetorno
//   4/7 SITUACAO     GET  {base}/situacao/{tiquete}
//   5/7 LINK         GET  {base}/download/{tiquete}
//   6/7 ARQUIVO      GET  urlAssinada (sem Bearer)
//   7/7 SALVAR       grava resultados/*.json

import http from 'node:http';
import fs from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UI_PORT = Number(process.env.UI_PORT || 3000);
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT || 3001);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhooks/apuracao-cbs';
// IPs de origem aceitos no webhook (doc: produção = 189.9.61.23/32). Vazio = só avisa.
const WEBHOOK_ALLOWED_IPS = (process.env.WEBHOOK_ALLOWED_IPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
// "basic" (padrão RFC 6749: Authorization: Basic) ou "body" (client_id/secret no corpo).
const TOKEN_AUTH_MODE = process.env.TOKEN_AUTH_MODE || 'basic';
const RESULT_DIR = path.join(__dirname, 'resultados');
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const TIMEOUT_MS = Number(process.env.RECEITA_TIMEOUT_MS || 60_000);
const TEMPO_LIMITE_MS = 4 * 60 * 60 * 1000 + 10 * 60 * 1000; // 240 min (doc) + folga

const AMBIENTES = {
  producao: {
    nome: 'Produção',
    token: 'https://api.receitafederal.gov.br/token',
    base: 'https://api.receitafederal.gov.br/apuracao-cbs/v2',
  },
  producaoRestrita: {
    nome: 'Produção restrita',
    token: 'https://api.receitafederal.gov.br/token',
    base: 'https://api.receitafederal.gov.br/apuracao-cbs-prr/v2',
  },
  homologacao: {
    nome: 'Homologação (exige IP liberado na ACL)',
    token: 'https://h-api.receitafederal.gov.br/token',
    base: 'https://h-api.receitafederal.gov.br/apuracao-cbs/v2',
  },
};

// Só para testes locais com um servidor simulado (ex.: MOCK_URL=http://127.0.0.1:4000).
if (process.env.MOCK_URL) {
  AMBIENTES.mock = {
    nome: 'Simulado (MOCK_URL)',
    token: `${process.env.MOCK_URL}/token`,
    base: `${process.env.MOCK_URL}/apuracao-cbs/v2`,
  };
}

const APIS = ['debitos', 'creditos', 'pagamentos', 'recolhimentos'];

const ETAPAS = {
  TOKEN: '1/7 TOKEN',
  ABERTURA: '2/7 ABERTURA',
  WEBHOOK: '3/7 WEBHOOK',
  SITUACAO: '4/7 SITUACAO',
  LINK: '5/7 LINK',
  ARQUIVO: '6/7 ARQUIVO',
  SALVAR: '7/7 SALVAR',
};

// Cabeçalhos de resposta úteis para diagnóstico (limite de requisições, rastreio no gateway).
const CABECALHOS_DIAGNOSTICO = [
  'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
  'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
  'x-request-id', 'x-correlation-id', 'activityid', 'x-amzn-requestid', 'www-authenticate',
];

/** id local -> solicitação (inclui tentativas que falharam antes de ter tíquete). */
const solicitacoes = new Map();
/** tiquete -> solicitação */
const porTiquete = new Map();
let contador = 0;

// ---------------------------------------------------------------- log

mkdirSync(LOG_DIR, { recursive: true });

function arquivoLog() {
  return path.join(LOG_DIR, `execucao-${new Date().toISOString().slice(0, 10)}.log`);
}

function log(nivel, msg) {
  const linha = `${new Date().toISOString()} ${nivel.padEnd(5)} ${msg}`;
  (nivel === 'ERRO' ? console.error : console.log)(linha);
  try { appendFileSync(arquivoLog(), `${linha}\n`, 'utf8'); } catch { /* log em arquivo é opcional */ }
}

function rotulo(sol) {
  return `[${sol.id}${sol.ticket ? ` | ${sol.ticket}` : ''}]`;
}

/** Registra no log e na linha do tempo da página. */
function evento(sol, msg, nivel = 'INFO') {
  sol.eventos.push({ em: new Date().toISOString(), nivel, msg });
  log(nivel, `${rotulo(sol)} ${msg}`);
}

function iniciarEtapa(sol, etapa) {
  sol.etapa = etapa;
}

/** Remove query string (a urlAssinada carrega a assinatura nela). */
function rotaSegura(url) {
  const u = new URL(url);
  return `${u.origin}${u.pathname}${u.search ? '?<oculto>' : ''}`;
}

function resumir(obj, max = 800) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return s.length > max ? `${s.slice(0, max)}…(${s.length} caracteres)` : s;
}

// ---------------------------------------------------------------- utilidades

function descartarCredenciais(sol, motivo) {
  if (!sol.creds) return;
  sol.creds.clientId = null;
  sol.creds.clientSecret = null;
  sol.creds = null;
  sol.token = null;
  evento(sol, `Credenciais apagadas da memória (${motivo}).`);
}

function publico(sol) {
  // Versão sem segredos para a UI.
  return {
    id: sol.id,
    ticket: sol.ticket,
    api: sol.api,
    cnpj: sol.cnpj,
    ambiente: sol.ambiente,
    urlRetorno: sol.urlRetorno,
    tEASegundos: sol.tEASegundos,
    situacao: sol.situacao,
    etapa: sol.etapa,
    falha: sol.falha,
    arquivo: sol.arquivo,
    credenciaisEmMemoria: !!sol.creds,
    criadoEm: sol.criadoEm,
    eventos: sol.eventos,
  };
}

async function lerCorpo(req, limite = 64 * 1024) {
  const partes = [];
  let total = 0;
  for await (const p of req) {
    total += p.length;
    if (total > limite) throw Object.assign(new Error('corpo muito grande'), { status: 413 });
    partes.push(p);
  }
  return Buffer.concat(partes).toString('utf8');
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** Erro de uma chamada à Receita, com etapa e rota. */
class ErroReceita extends Error {
  constructor({ etapa, metodo, rota, status, resposta, causa }) {
    const detalhe = status
      ? `HTTP ${status}: ${resumir(resposta, 400)}`
      : `falha de rede: ${causa}`;
    super(`[${etapa}] ${metodo} ${rota} -> ${detalhe}`);
    Object.assign(this, { etapa, metodo, rota, statusHttp: status, resposta, causa });
  }
}

/**
 * Faz uma chamada HTTP à Receita registrando ida, volta, tempo, status e cabeçalhos de diagnóstico.
 * Nunca registra o cabeçalho Authorization nem o corpo enviado ao token.
 * Retorna { resp, texto, dados }. Lança ErroReceita em falha de rede ou status inesperado.
 */
async function chamarReceita(sol, etapa, metodo, url, { headers = {}, body, esperado, logCorpo = true } = {}) {
  const rota = rotaSegura(url);
  iniciarEtapa(sol, etapa);
  evento(sol, `[${etapa}] -> ${metodo} ${rota}${body && logCorpo ? ` corpo=${resumir(String(body), 300)}` : ''}`);

  const inicio = Date.now();
  let resp;
  try {
    resp = await fetch(url, { method: metodo, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const causa = e.name === 'TimeoutError'
      ? `sem resposta em ${TIMEOUT_MS / 1000}s`
      : `${e.cause?.code || e.name} ${e.cause?.message || e.message}`;
    const erro = new ErroReceita({ etapa, metodo, rota, causa });
    evento(sol, `[${etapa}] <- ${erro.message} (${Date.now() - inicio}ms)`, 'ERRO');
    throw erro;
  }

  const texto = await resp.text();
  let dados;
  try { dados = JSON.parse(texto); } catch { dados = { bruto: texto.slice(0, 500) }; }
  const ms = Date.now() - inicio;

  const diag = CABECALHOS_DIAGNOSTICO
    .map((h) => [h, resp.headers.get(h)])
    .filter(([, v]) => v)
    .map(([h, v]) => `${h}=${v}`)
    .join(' ');

  const ok = esperado ? esperado.includes(resp.status) : resp.ok;
  if (!ok) {
    const erro = new ErroReceita({ etapa, metodo, rota, status: resp.status, resposta: dados });
    evento(sol, `[${etapa}] <- HTTP ${resp.status} em ${ms}ms${diag ? ` | ${diag}` : ''} | resposta=${resumir(dados)}`, 'ERRO');
    throw erro;
  }
  evento(sol, `[${etapa}] <- HTTP ${resp.status} em ${ms}ms${diag ? ` | ${diag}` : ''}`);
  return { resp, texto, dados };
}

/** Marca a solicitação como parada numa etapa, para a página e o log mostrarem onde foi. */
function registrarFalha(sol, e) {
  sol.falha = {
    etapa: e.etapa || sol.etapa || 'desconhecida',
    rota: e.rota ? `${e.metodo} ${e.rota}` : undefined,
    status: e.statusHttp,
    mensagem: e.message,
  };
  evento(sol, `PROCESSO PAROU na etapa ${sol.falha.etapa}: ${e.message}`, 'ERRO');
  evento(sol, `Dica: ${dica(e)}`, 'ERRO');
}

function dica(e) {
  if (!e.statusHttp) {
    if (e.etapa === ETAPAS.SALVAR) return 'não foi possível gravar o arquivo em resultados/.';
    return 'sem resposta da Receita: verifique internet, proxy/firewall corporativo ou a URL do ambiente.';
  }
  const s = e.statusHttp;
  if (e.etapa === ETAPAS.TOKEN) {
    if (s === 400 || s === 401) return 'client_id/secret inválidos ou formato de envio diferente; tente TOKEN_AUTH_MODE=body.';
    if (s === 429) return 'limite de requisições do token; aguarde antes de tentar de novo (veja retry-after acima, se houver).';
  }
  if (s === 401) return 'token recusado ou CNPJ não vinculado à credencial (deve ser a matriz).';
  if (s === 403) return 'token válido, mas a credencial não tem permissão para esta rota/ambiente. Teste o outro ambiente ou confira a liberação da API.';
  if (s === 404) return e.etapa === ETAPAS.LINK
    ? 'arquivo ainda não pronto ou já baixado.'
    : 'rota inexistente neste ambiente (confira ambiente e tipo de consulta).';
  if (s === 429) return 'limite de requisições (4 por dia por credencial e por API na abertura).';
  if (s === 400 && e.etapa === ETAPAS.ABERTURA) return 'corpo inválido ou o HEAD da Receita não alcançou o webhook (túnel parado/URL errada).';
  if (s >= 500) return 'erro do lado da Receita; tente mais tarde.';
  return 'veja a resposta acima.';
}

// ---------------------------------------------------------------- OAuth2

async function obterToken(sol) {
  if (!sol.creds) throw new Error('Credenciais já foram descartadas. Faça nova solicitação.');
  if (sol.token && sol.token.expiraEm > Date.now() + 60_000) {
    evento(sol, `[${ETAPAS.TOKEN}] reutilizando token em cache (expira ${new Date(sol.token.expiraEm).toISOString()})`);
    return sol.token.valor;
  }

  const amb = AMBIENTES[sol.ambiente];
  const corpo = new URLSearchParams({ grant_type: 'client_credentials' });
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (TOKEN_AUTH_MODE === 'body') {
    corpo.set('client_id', sol.creds.clientId);
    corpo.set('client_secret', sol.creds.clientSecret);
  } else {
    const basic = Buffer.from(`${sol.creds.clientId}:${sol.creds.clientSecret}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }

  // logCorpo=false: o corpo pode conter o secret (modo body).
  const { dados } = await chamarReceita(sol, ETAPAS.TOKEN, 'POST', amb.token, {
    headers, body: corpo.toString(), logCorpo: false,
  });
  if (!dados.access_token) {
    const erro = new ErroReceita({
      etapa: ETAPAS.TOKEN, metodo: 'POST', rota: amb.token, status: 200,
      resposta: { aviso: 'resposta sem access_token', campos: Object.keys(dados) },
    });
    throw erro;
  }
  const segundos = Number(dados.expires_in) || 3600; // manual: 60 min
  sol.token = { valor: dados.access_token, expiraEm: Date.now() + segundos * 1000 };
  evento(sol, `[${ETAPAS.TOKEN}] token obtido (tipo=${dados.token_type || '?'}, expira em ${segundos}s` +
    `${dados.scope ? `, scope=${dados.scope}` : ''})`);
  return sol.token.valor;
}

// ---------------------------------------------------------------- chamadas à API

async function abrirSolicitacao({ clientId, clientSecret, ambiente, api, cnpj, urlRetorno }) {
  const sol = {
    id: `#${++contador}`,
    ticket: null,
    api, cnpj, ambiente, urlRetorno,
    creds: { clientId, clientSecret },
    token: null,
    situacao: 'ABRINDO',
    etapa: null,
    eventos: [],
    criadoEm: Date.now(),
  };
  solicitacoes.set(sol.id, sol);
  evento(sol, `Nova solicitação: ambiente=${AMBIENTES[ambiente].nome} api=${api} cnpj=${cnpj} ` +
    `urlRetorno=${urlRetorno} auth=${TOKEN_AUTH_MODE}`);

  try {
    const token = await obterToken(sol);
    // A Receita fará um HEAD em urlRetorno antes de responder — o webhook precisa estar no ar.
    const { dados } = await chamarReceita(sol, ETAPAS.ABERTURA, 'POST', `${AMBIENTES[ambiente].base}/${api}/${cnpj}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ urlRetorno }),
      esperado: [200, 201, 202],
    });
    if (!dados.tiqueteSolicitacao) {
      throw new ErroReceita({
        etapa: ETAPAS.ABERTURA, metodo: 'POST', rota: `${AMBIENTES[ambiente].base}/${api}/${cnpj}`,
        status: 200, resposta: { aviso: 'resposta sem tiqueteSolicitacao', dados },
      });
    }
    sol.ticket = dados.tiqueteSolicitacao;
    sol.tEASegundos = dados.tEASegundos;
    sol.situacao = 'PENDENTE';
    porTiquete.set(sol.ticket, sol);
    iniciarEtapa(sol, ETAPAS.WEBHOOK);
    evento(sol, `Solicitação aberta. Tíquete=${sol.ticket}. Tempo estimado: ` +
      `${dados.tEASegundos === -1 ? 'sem estimativa' : `${dados.tEASegundos}s`}. Aguardando webhook (etapa ${ETAPAS.WEBHOOK})…`);
    return sol;
  } catch (e) {
    sol.situacao = 'FALHOU';
    registrarFalha(sol, e);
    descartarCredenciais(sol, 'falha na abertura');
    throw e;
  }
}

async function consultarSituacao(sol) {
  const { resp, dados } = await chamarReceita(
    sol, ETAPAS.SITUACAO, 'GET', `${AMBIENTES[sol.ambiente].base}/situacao/${encodeURIComponent(sol.ticket)}`,
    {
      headers: { Authorization: `Bearer ${await obterToken(sol)}`, Accept: 'application/json' },
      // A doc devolve situacao=ERRO também com 400/404/500; tratamos o corpo nesses casos.
      esperado: [200, 400, 404, 500],
    },
  );
  evento(sol, `[${ETAPAS.SITUACAO}] HTTP ${resp.status} situacao=${dados.situacao || '?'}` +
    `${dados.codigoErro ? ` codigoErro=${dados.codigoErro} mensagemErro=${dados.mensagemErro}` : ''}`,
  resp.ok ? 'INFO' : 'ERRO');
  if (dados.situacao) await tratarSituacao(sol, dados.situacao, dados);
  else if (!resp.ok) {
    throw new ErroReceita({ etapa: ETAPAS.SITUACAO, metodo: 'GET', rota: `${AMBIENTES[sol.ambiente].base}/situacao/…`, status: resp.status, resposta: dados });
  }
  return dados;
}

async function baixarResultado(sol) {
  const { dados } = await chamarReceita(
    sol, ETAPAS.LINK, 'GET', `${AMBIENTES[sol.ambiente].base}/download/${encodeURIComponent(sol.ticket)}`,
    { headers: { Authorization: `Bearer ${await obterToken(sol)}`, Accept: 'application/json' } },
  );
  if (!dados.urlAssinada) {
    throw new ErroReceita({
      etapa: ETAPAS.LINK, metodo: 'GET', rota: `${AMBIENTES[sol.ambiente].base}/download/…`,
      status: 200, resposta: { aviso: 'resposta sem urlAssinada', campos: Object.keys(dados) },
    });
  }
  evento(sol, `[${ETAPAS.LINK}] link assinado obtido (expira em ${dados.urlAssinadaExpiraEm}).`);

  // A urlAssinada é um segredo: chamarReceita registra só host/caminho, sem a query.
  const { texto } = await chamarReceita(sol, ETAPAS.ARQUIVO, 'GET', dados.urlAssinada);
  evento(sol, `[${ETAPAS.ARQUIVO}] ${texto.length} caracteres recebidos.`);

  iniciarEtapa(sol, ETAPAS.SALVAR);
  const nome = `${sol.api}-${sol.cnpj}-${sol.ticket.replace(/[^\w.-]/g, '_')}.json`;
  try {
    await fs.mkdir(RESULT_DIR, { recursive: true });
    let formatado = texto;
    try { formatado = JSON.stringify(JSON.parse(texto), null, 2); } catch {
      evento(sol, `[${ETAPAS.SALVAR}] aviso: conteúdo não é JSON válido; salvo como recebido.`, 'AVISO');
    }
    await fs.writeFile(path.join(RESULT_DIR, nome), formatado, 'utf8');
  } catch (e) {
    throw Object.assign(new Error(`[${ETAPAS.SALVAR}] ${e.message}`), { etapa: ETAPAS.SALVAR });
  }
  sol.arquivo = `resultados/${nome}`;
  sol.situacao = 'BAIXADO';
  sol.etapa = 'CONCLUÍDO';
  evento(sol, `[${ETAPAS.SALVAR}] resultado salvo em ${sol.arquivo}. Processo concluído.`);
  descartarCredenciais(sol, 'resultado baixado');
}

async function tratarSituacao(sol, situacao, dados = {}) {
  if (sol.situacao === 'BAIXADO') return;
  sol.situacao = situacao;
  if (situacao === 'CONCLUIDA') {
    try {
      await baixarResultado(sol);
    } catch (e) {
      registrarFalha(sol, e);
    }
  } else if (situacao === 'ERRO' || situacao === 'EXPIRADA') {
    registrarFalha(sol, Object.assign(
      new Error(`Receita informou ${situacao}: ${dados.codigoErro || ''} ${dados.mensagemErro || ''}`.trim()),
      { etapa: ETAPAS.SITUACAO },
    ));
    descartarCredenciais(sol, `situação ${situacao}`);
  } else {
    evento(sol, `Ainda em processamento (${situacao}). Aguardando webhook.`);
  }
}

// ---------------------------------------------------------------- servidor do webhook (porta pública via túnel)

function ipOrigem(req) {
  // Atrás de túnel (ngrok/cloudflared) o IP real vem nos cabeçalhos.
  const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '';
  return String(fwd).split(',')[0].trim() || req.socket.remoteAddress;
}

const webhookServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = ipOrigem(req);
  log('INFO', `[webhook] ${req.method} ${url.pathname} de ${ip} (user-agent: ${req.headers['user-agent'] || '-'})`);

  if (url.pathname !== WEBHOOK_PATH) {
    log('AVISO', `[webhook] caminho inesperado ${url.pathname}; esperado ${WEBHOOK_PATH}. Respondido 404.`);
    return json(res, 404, { erro: 'não encontrado' });
  }

  // A Receita valida o endpoint com HEAD antes de aceitar a solicitação.
  if (req.method === 'HEAD' || req.method === 'GET') {
    for (const sol of solicitacoes.values()) {
      if (sol.situacao === 'ABRINDO') {
        evento(sol, `[${ETAPAS.ABERTURA}] validação ${req.method} da urlRetorno recebida de ${ip}; respondido 200.`);
      }
    }
    res.writeHead(200);
    return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { erro: 'método não permitido' });

  if (WEBHOOK_ALLOWED_IPS.length && !WEBHOOK_ALLOWED_IPS.includes(ip)) {
    log('AVISO', `[webhook] RECUSADO: IP ${ip} fora de WEBHOOK_ALLOWED_IPS.`);
    return json(res, 403, { erro: 'origem não autorizada' });
  }

  let payload;
  try {
    payload = JSON.parse(await lerCorpo(req));
  } catch (e) {
    log('ERRO', `[webhook] corpo inválido de ${ip}: ${e.message}`);
    return json(res, 400, { erro: 'JSON inválido' });
  }
  // Responde rápido; processa depois.
  json(res, 200, { recebido: true });

  const sol = porTiquete.get(payload.tiqueteSolicitacao);
  if (!sol) {
    log('AVISO', `[webhook] tíquete desconhecido (servidor reiniciado ou não é desta execução): ${resumir(payload)}`);
    return;
  }
  iniciarEtapa(sol, ETAPAS.WEBHOOK);
  evento(sol, `[${ETAPAS.WEBHOOK}] recebido de ${ip}: ${resumir(payload)}`);
  if (!WEBHOOK_ALLOWED_IPS.length && ip !== '189.9.61.23') {
    evento(sol, `[${ETAPAS.WEBHOOK}] aviso: IP ${ip} não é o IP documentado da Receita (189.9.61.23). ` +
      'O webhook não tem assinatura, por isso a situação será confirmada na API antes de baixar.', 'AVISO');
  }

  // O webhook não é assinado (FAQ). Confirmamos a situação na própria API antes de agir.
  try {
    await consultarSituacao(sol);
  } catch (e) {
    registrarFalha(sol, e);
  }
});

// ---------------------------------------------------------------- servidor da interface (somente localhost)

const HTML = await fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');
const HOSTS_OK = new Set([`localhost:${UI_PORT}`, `127.0.0.1:${UI_PORT}`]);

const uiServer = http.createServer(async (req, res) => {
  // Protege contra DNS rebinding: só aceita Host local.
  if (!HOSTS_OK.has(req.headers.host)) return json(res, 403, { erro: 'host não permitido' });
  const url = new URL(req.url, 'http://x');

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, {
        webhookPath: WEBHOOK_PATH,
        webhookPort: WEBHOOK_PORT,
        ambientes: Object.fromEntries(Object.entries(AMBIENTES).map(([k, v]) => [k, v.nome])),
        apis: APIS,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/solicitacoes') {
      return json(res, 200, [...solicitacoes.values()].reverse().map(publico));
    }

    if (req.method === 'POST' && url.pathname === '/api/solicitar') {
      if (!String(req.headers['content-type'] || '').includes('application/json')) {
        return json(res, 415, { erro: 'use application/json' });
      }
      const b = JSON.parse(await lerCorpo(req));
      const cnpj = String(b.cnpj || '').replace(/\D/g, '').slice(0, 8);
      const erros = [];
      if (!b.clientId || !b.clientSecret) erros.push('informe client_id e client_secret');
      if (!AMBIENTES[b.ambiente]) erros.push('ambiente inválido');
      if (!APIS.includes(b.api)) erros.push('API inválida');
      if (cnpj.length !== 8) erros.push('CNPJ base deve ter 8 dígitos (ou informe o CNPJ completo)');
      let urlRetorno = String(b.urlPublica || '').trim().replace(/\/+$/, '');
      if (!/^https:\/\//i.test(urlRetorno)) erros.push('URL pública do webhook deve começar com https://');
      if (!urlRetorno.endsWith(WEBHOOK_PATH)) urlRetorno += WEBHOOK_PATH;
      if (erros.length) {
        log('AVISO', `[ui] solicitação rejeitada na validação local: ${erros.join('; ')}`);
        return json(res, 400, { erro: erros.join('; ') });
      }

      try {
        const sol = await abrirSolicitacao({
          clientId: String(b.clientId), clientSecret: String(b.clientSecret),
          ambiente: b.ambiente, api: b.api, cnpj, urlRetorno,
        });
        return json(res, 201, publico(sol));
      } catch (e) {
        return json(res, 502, { erro: e.message, etapa: e.etapa, rota: e.rota, status: e.statusHttp });
      }
    }

    const m = url.pathname.match(/^\/api\/(situacao|descartar)\/(.+)$/);
    if (req.method === 'POST' && m) {
      const sol = solicitacoes.get(decodeURIComponent(m[2]));
      if (!sol) return json(res, 404, { erro: 'solicitação desconhecida' });
      if (m[1] === 'descartar') {
        descartarCredenciais(sol, 'pedido do usuário');
      } else {
        evento(sol, 'Consulta manual de situação solicitada pela página.');
        try {
          await consultarSituacao(sol);
        } catch (e) {
          registrarFalha(sol, e);
          return json(res, 502, { erro: e.message, etapa: e.etapa, rota: e.rota, status: e.statusHttp });
        }
      }
      return json(res, 200, publico(sol));
    }

    return json(res, 404, { erro: 'não encontrado' });
  } catch (e) {
    log('ERRO', `[ui] ${req.method} ${url.pathname}: ${e.stack || e.message}`);
    return json(res, e.status || 500, { erro: e.message });
  }
});

// Apaga credenciais de solicitações que passaram do tempo limite de 240 minutos.
setInterval(() => {
  for (const sol of solicitacoes.values()) {
    if (sol.creds && Date.now() - sol.criadoEm > TEMPO_LIMITE_MS) {
      if (sol.situacao !== 'BAIXADO') {
        sol.situacao = 'EXPIRADA';
        registrarFalha(sol, Object.assign(
          new Error('nenhum webhook concluído em 240 minutos'), { etapa: sol.etapa || ETAPAS.WEBHOOK },
        ));
      }
      descartarCredenciais(sol, 'tempo limite de 240 min');
    }
  }
}, 60_000).unref();

process.on('unhandledRejection', (e) => log('ERRO', `erro não tratado: ${e?.stack || e}`));

uiServer.listen(UI_PORT, '127.0.0.1', () => {
  log('INFO', `Interface:  http://localhost:${UI_PORT}   (somente local — não exponha esta porta)`);
});
webhookServer.listen(WEBHOOK_PORT, '127.0.0.1', () => {
  log('INFO', `Webhook:    http://127.0.0.1:${WEBHOOK_PORT}${WEBHOOK_PATH}   (aponte o túnel HTTPS para esta porta)`);
  log('INFO', `Autenticação no token: ${TOKEN_AUTH_MODE === 'body' ? 'client_id/secret no corpo' : 'HTTP Basic'}`);
  log('INFO', `Logs gravados em ${arquivoLog()}`);
  if (WEBHOOK_ALLOWED_IPS.length) log('INFO', `Webhook aceita apenas os IPs: ${WEBHOOK_ALLOWED_IPS.join(', ')}`);
});
