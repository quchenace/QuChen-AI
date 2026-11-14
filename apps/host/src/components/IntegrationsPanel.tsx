import { useEffect, useRef, useState } from 'react';
import { Btn, ErrorNotice } from './ui';
import { api } from '../lib/client';
import { tr } from '../lib/i18n';

type Health = { at: number; checking: boolean; ready: number; total: number; best: { model: string; ms: number }[]; error?: string | null };
type Gateway = { dir: string; port: number; running: boolean; present: boolean; models: string[]; pid: number | null; log: string; health?: Health | null; catalogue?: { models: number; providers: number; catalogue: string; catalogueProviders: number; skipped: number; keys: number } | null };
type Progress = { phase: string; done: number; total: number; message: string };
type Tool = { dir: string; installed: boolean; exe: string | null; running: boolean; progress: Progress };
type Status = { gateway: Gateway; vpn: Tool; radio: Tool };

function Dot({ on }: { on: boolean }) {
    return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: on ? '#22c55e' : '#9ca3af', marginRight: 6 }}/>;
}

function ToolProgress({ progress }: { progress?: Progress }) {
    if (!progress) return null;
    return <>
        {['resolving', 'downloading', 'installing', 'unpacking'].includes(progress.phase)
            ? <div style={{ margin: '8px 0 0' }}>
                <div style={{ height: 6, background: 'var(--line, #e5e7eb)', borderRadius: 999, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: (progress.total ? Math.min(100, Math.round(progress.done / progress.total * 100)) : 5) + '%', background: '#22c55e', transition: 'width .3s' }}/>
                </div>
                <p className="small muted" style={{ margin: '4px 0 0' }}>{progress.message}{progress.total ? ` · ${Math.round(progress.done / 1048576)} / ${Math.round(progress.total / 1048576)} MB` : ''}</p>
            </div>
            : null}
        {progress.phase === 'done' ? <p className="small muted" style={{ margin: '6px 0 0' }}>{progress.message}</p> : null}
        {progress.phase === 'error' ? <p className="small inline-error">{progress.message}</p> : null}
    </>;
}

/** Settings › Integrations: gateway controls stay here; Harness/OpenCode/serving controls do not. */
export function IntegrationsPanel() {
    const [status, setStatus] = useState<Status | null>(null);
    const [pending, setPending] = useState('');
    const [error, setError] = useState('');
    const [note, setNote] = useState('');
    const [showLog, setShowLog] = useState(false);
    const file = useRef<HTMLInputElement | null>(null);

    async function load() {
        try { setStatus(await api.get<Status>('/api/integrations')); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }
    useEffect(() => {
        setError(''); setNote('');
        void load();
        const timer = setInterval(() => void load(), 5000);
        return () => clearInterval(timer);
    }, []);

    async function upload(picked: File) {
        setPending('vpn'); setError(''); setNote('');
        try {
            const res = await fetch('/api/integrations/vpn-file', { method: 'POST', headers: { 'x-file-name': picked.name }, body: picked });
            const doc = await res.json().catch(() => ({} as { error?: string }));
            if (!res.ok) throw new Error((doc as { error?: string })?.error ?? '安装失败。');
            setNote(tr('装好了，点「启动」即可。')); await load();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setPending(''); }
    }

    async function call(name: string, url: string, payload: Record<string, unknown>, done: string) {
        setPending(name); setError(''); setNote('');
        try { await api.post(url, payload); setNote(done); await load(); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setPending(''); }
    }

    const g = status?.gateway, v = status?.vpn, r = status?.radio;
    const busy = pending !== '';

    return <div className="stack stack--lg">
        <div className="stack">
            <section className="st-card">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <strong><Dot on={!!g?.running}/>{tr('免费网关')}</strong>
                        <span className="small muted"> 127.0.0.1:{g?.port ?? 4000}</span>
                    </div>
                    <div className="row">
                        {!g?.present
                            ? <Btn size="sm" icon="download" disabled={busy} onClick={() => void call('gw', '/api/integrations/gateway', { action: 'install' }, tr('免费网关装好了，点「启动」就能用。'))}>{pending === 'gw' ? tr('安装中…') : tr('安装')}</Btn>
                            : g.running
                                ? <><Btn size="sm" variant="ghost" disabled={busy} onClick={() => void call('gwhealth', '/api/integrations/gateway/health', {}, tr('健康检查完成。'))}>{pending === 'gwhealth' ? tr('检查中…') : tr('检查可用性')}</Btn><Btn size="sm" variant="ghost" disabled={busy} onClick={() => void call('gw', '/api/integrations/gateway', { action: 'stop' }, tr('网关已停止。'))}>{tr('停止')}</Btn></>
                                : <Btn size="sm" icon="bolt" disabled={busy} onClick={() => void call('gw', '/api/integrations/gateway', { action: 'start' }, tr('网关已启动（几秒后就绪）。'))}>{tr('启动')}</Btn>}
                    </div>
                </div>
                {!g?.present
                    ? <p className="small muted" style={{ margin: '6px 0 0' }}>{tr('For first-time setup, click Install. QuChen uses its bundled Python to install the gateway locally; after that, just start it.')}</p>
                    : <p className="small muted" style={{ margin: '6px 0' }}>{g.dir}</p>}
                {g && g.present && g.models.length ? <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                    {g.models.map((m) => <span key={m} className="small" style={{ border: '1px solid var(--line, #e5e7eb)', borderRadius: 999, padding: '1px 8px' }}>{m}</span>)}
                </div> : null}
                {g?.catalogue ? <p className="small muted" style={{ margin: '6px 0 0' }}>
                    {tr('模型目录')} {g.catalogue.catalogue} · {tr('已启用')} {g.catalogue.providers} {tr('个上游')}
                    {g.catalogue.skipped ? ` · ${tr('{0} more can be enabled by adding API keys', [g.catalogue.skipped])}` : ''}
                </p> : null}
                {g?.health && g.health.total ? <p className="small muted" style={{ margin: '6px 0 0' }}>
                    {tr('可用性')} {g.health.ready}/{g.health.total} · {tr('推荐')}{' '}
                    {g.health.best.slice(0, 3).map((x) => x.model + ' ' + x.ms + 'ms').join(' · ') || '—'}
                    {g.health.error ? ' · ' + g.health.error : ''}
                </p> : null}
                {g?.present ? <details style={{ marginTop: 8 }} open={showLog} onToggle={(e) => setShowLog((e.target as HTMLDetailsElement).open)}>
                    <summary className="small">{tr('日志')}</summary>
                    <pre className="small muted" style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{g.log || '—'}</pre>
                </details> : null}
            </section>

            <section className="st-card">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <strong><Dot on={!!v?.running}/>{tr('网络工具（可选）')}</strong>
                        <span className="small muted"> QuChen VPN</span>
                    </div>
                    <div className="row">
                        {!v?.running ? <Btn size="sm" variant="ghost" disabled={busy} onClick={() => file.current?.click()}>{tr('从本地文件…')}</Btn> : null}
                        {!v?.installed
                            ? <Btn size="sm" icon="download" disabled={busy} onClick={() => void call('vpn', '/api/integrations/vpn', { action: 'install' }, tr('装好了，点「启动」即可。'))}>{pending === 'vpn' ? tr('下载中…') : tr('下载安装')}</Btn>
                            : v.running
                                ? <Btn size="sm" variant="ghost" disabled={busy} onClick={() => void call('vpn', '/api/integrations/vpn', { action: 'stop' }, tr('已停止。'))}>{tr('停止')}</Btn>
                                : <Btn size="sm" icon="bolt" disabled={busy} onClick={() => void call('vpn', '/api/integrations/vpn', { action: 'start' }, tr('已启动，看托盘图标。'))}>{tr('启动')}</Btn>}
                    </div>
                </div>
                <ToolProgress progress={v?.progress}/>
                <p className="small muted" style={{ margin: '6px 0 0' }}>{v?.installed ? v.dir : tr('Install this only when you need access to GitHub; chat and the gateway work without it. Official Setup.exe and portable zip files are supported, with speed tests and download progress.')}</p>
                <input ref={file} type="file" accept=".zip,.exe" hidden onChange={(e) => { const picked = e.target.files?.[0]; if (!picked) return; void upload(picked); e.target.value = ''; }}/>
            </section>

            <section className="st-card">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <strong><Dot on={!!r?.running}/>{tr('音乐电台（可选）')}</strong>
                        <span className="small muted"> QUCHEN Radio</span>
                    </div>
                    <div className="row">
                        {!r?.installed
                            ? <Btn size="sm" icon="download" disabled={busy} onClick={() => void call('radio', '/api/integrations/radio', { action: 'install' }, tr('装好了，点「启动」即可。'))}>{pending === 'radio' ? tr('下载中…') : tr('下载安装')}</Btn>
                            : r.running
                                ? <Btn size="sm" variant="ghost" disabled={busy} onClick={() => void call('radio', '/api/integrations/radio', { action: 'stop' }, tr('已停止。'))}>{tr('停止')}</Btn>
                                : <Btn size="sm" icon="bolt" disabled={busy} onClick={() => void call('radio', '/api/integrations/radio', { action: 'start' }, tr('已启动。'))}>{tr('启动')}</Btn>}
                    </div>
                </div>
                <ToolProgress progress={r?.progress}/>
                <p className="small muted" style={{ margin: '6px 0 0' }}>{r?.installed ? r.dir : tr('A standalone music player that you can launch here after installation. AI chat in Radio uses QuChen-AI models and does not start another AI service.')}</p>
            </section>

            {note ? <p className="small">{note}</p> : null}
            {error ? <ErrorNotice message={error}/> : null}
        </div>
    </div>;
}
