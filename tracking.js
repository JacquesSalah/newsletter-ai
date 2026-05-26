/**
 * tracking.js — Decomposer Newsletter
 * Mede scroll depth e tempo de leitura ativo em cada artigo.
 * Envia os dados via sendBeacon quando o leitor sai da página.
 *
 * Como usar: <script src="../../tracking.js"></script> no <head> de cada artigo.
 * O script detecta o article-id automaticamente pela URL.
 */

(function () {

  // ── CONFIG — substitua pela sua URL e chave do Supabase ──────────────────
  const TRACK_ENDPOINT = 'https://zcqneiklcvsaycshqxrv.supabase.co/functions/v1/track-read';
  // (Edge Function do Supabase — ver instruções no final do arquivo)

  // ── ARTICLE ID ────────────────────────────────────────────────────────────
  // Deriva o ID do artigo a partir do caminho da URL.
  // Ex: /articles/byd_article/byd_article.html → "byd_article"
  function getArticleId() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    // Pega a pasta do artigo (penúltimo segmento do caminho)
    const folder = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return folder || 'unknown';
  }

  const articleId = getArticleId();

  // ── VISITOR TOKEN ─────────────────────────────────────────────────────────
  // UUID anônimo por sessão de browser — não vincula a dados pessoais
  function getVisitorToken() {
    let token = sessionStorage.getItem('dcmp_visitor');
    if (!token) {
      token = 'anon-' + crypto.randomUUID();
      sessionStorage.setItem('dcmp_visitor', token);
    }
    return token;
  }

  // ── SCROLL TRACKING ───────────────────────────────────────────────────────
  // Observa quando o leitor atinge marcos de 25 / 50 / 75 / 100% do artigo
  let maxScrollPct = 0;

  function setupScrollTracking() {
    // Tenta encontrar o conteúdo do artigo em ordem de preferência
    const contentEl =
      document.querySelector('.article-body') ||
      document.querySelector('.article-wrapper') ||
      document.querySelector('article') ||
      document.body;

    const milestones = [25, 50, 75, 100];

    milestones.forEach(pct => {
      const sentinel = document.createElement('div');
      sentinel.style.cssText = 'position:absolute;left:0;width:1px;height:1px;pointer-events:none;visibility:hidden;';
      sentinel.style.top = pct + '%';
      sentinel.dataset.milestone = pct;

      if (getComputedStyle(contentEl).position === 'static') {
        contentEl.style.position = 'relative';
      }
      contentEl.appendChild(sentinel);
    });

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const pct = parseInt(entry.target.dataset.milestone, 10);
          if (pct > maxScrollPct) maxScrollPct = pct;
        }
      });
    }, { threshold: 0 });

    contentEl.querySelectorAll('[data-milestone]').forEach(el => observer.observe(el));
  }

  // ── TEMPO DE LEITURA ATIVO ────────────────────────────────────────────────
  // Pausa o timer quando a aba vai para segundo plano (Page Visibility API)
  let activeSeconds = 0;
  let sessionStart = Date.now();
  let isVisible = !document.hidden;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && isVisible) {
      activeSeconds += Math.round((Date.now() - sessionStart) / 1000);
      isVisible = false;
    } else if (!document.hidden && !isVisible) {
      sessionStart = Date.now();
      isVisible = true;
    }
  });

  // ── ENVIO ─────────────────────────────────────────────────────────────────
  function sendData() {
    const finalSeconds = isVisible
      ? activeSeconds + Math.round((Date.now() - sessionStart) / 1000)
      : activeSeconds;

    // Ignora leituras de menos de 3 segundos sem nenhum scroll
    if (finalSeconds < 3 && maxScrollPct === 0) return;

    const payload = JSON.stringify({
      article_id:    articleId,
      visitor_token: getVisitorToken(),
      scroll_pct:    maxScrollPct,
      duration_sec:  finalSeconds,
    });

    // sendBeacon garante o envio mesmo ao fechar a aba
    navigator.sendBeacon(TRACK_ENDPOINT, new Blob([payload], { type: 'application/json' }));
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) sendData(); });
  window.addEventListener('pagehide', sendData);

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupScrollTracking);
  } else {
    setupScrollTracking();
  }

})();

/*
 * ── EDGE FUNCTION DO SUPABASE (track-read) ───────────────────────────────────
 *
 * sendBeacon não envia headers customizados, então não dá para chamar a API
 * REST do Supabase diretamente. A solução é uma Edge Function que recebe o
 * payload e salva no banco internamente, com a chave de serviço protegida.
 *
 * Criar em: Supabase Dashboard → Edge Functions → New Function → "track-read"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
 *
 * Deno.serve(async (req) => {
 *   // Permite requisições de qualquer origem (necessário para sendBeacon)
 *   if (req.method === 'OPTIONS') {
 *     return new Response(null, {
 *       headers: {
 *         'Access-Control-Allow-Origin': '*',
 *         'Access-Control-Allow-Methods': 'POST',
 *       }
 *     });
 *   }
 *
 *   const body = await req.json();
 *   const { article_id, visitor_token, scroll_pct, duration_sec } = body;
 *
 *   // Validação básica
 *   if (!article_id || !visitor_token) {
 *     return new Response('invalid', { status: 400 });
 *   }
 *
 *   const supabase = createClient(
 *     Deno.env.get('SUPABASE_URL'),
 *     Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
 *   );
 *
 *   // Upsert: se o mesmo visitante voltar ao artigo, atualiza o registro
 *   await supabase.from('reads').upsert({
 *     article_id, visitor_token, scroll_pct, duration_sec
 *   }, { onConflict: 'article_id,visitor_token' });
 *
 *   return new Response('ok', {
 *     headers: { 'Access-Control-Allow-Origin': '*' }
 *   });
 * });
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SQL para criar a tabela no Supabase:
 *
 *   create table reads (
 *     id            uuid primary key default gen_random_uuid(),
 *     article_id    text not null,
 *     visitor_token text not null,
 *     scroll_pct    integer default 0,
 *     duration_sec  integer default 0,
 *     recorded_at   timestamptz default now(),
 *     unique (article_id, visitor_token)
 *   );
 */
