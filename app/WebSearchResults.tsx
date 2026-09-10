import { safeWebUrl, type WebSearchResult } from "../shared/web-search";

export function WebSearchResults({ result }: { result: WebSearchResult }) {
  if (!result.searched) return <p className="search-notice" role="status">本次未获得可引用的网页结果，以上仅为知识库回答。</p>;
  return <section className="web-results" aria-label="联网补充">
    <h2>联网补充 <small>Google 搜索 · 独立于内部资料</small></h2>
    <div className="message-content">{result.text}</div>
    <div className="citations web-citations"><p>网页来源</p>{result.sources.map((source) => {
      const url = safeWebUrl(source.url);
      return url ? <a key={url} href={url} target="_blank" rel="noopener noreferrer"><span>{source.title}<small>{new URL(url).hostname}</small></span><em aria-hidden="true">↗</em></a> : null;
    })}</div>
    {result.searchSuggestions && <iframe
      title="Google 搜索建议"
      className="search-suggestions"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'"><base target="_blank"></head><body>${result.searchSuggestions}</body></html>`}
    />}
    <p className="search-disclaimer">联网补充仅当次展示，不写入知识库或历史记录；公司内部规定请以知识库资料为准。</p>
  </section>;
}
