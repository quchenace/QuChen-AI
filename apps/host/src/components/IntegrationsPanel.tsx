import { useEffect, useRef, useState } from 'react';
import { Btn, ErrorNotice } from './ui';
import { api } from '../lib/client';
import { tr } from '../lib/i18n';

type Harness = {
    profile: string; exists: boolean; current: string | null;
    model: string | null; port: number | null; baseUrl: string | null; via: string;
    localModels: string[]; gatewayModels: string[];
    autoSync: boolean; lastSync: string | null;
};
type Gateway = { dir: string; port: number; running: boolean; present: boolean; models: string[]; pid: number | null; log: string };
type Vpn = { dir: string; installed: boolean; exe: string | null; running: boolean; progress: { phase: string; done: number; total: number; message: string } };
type Status = { harness: Harness; gateway: Gateway; vpn: Vpn };

function Dot({ on }: { on: boolean }) {
    return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: on ? '#22c55e' : '#9ca3af', marginRight: 6 }}/>;
}
function when(iso: string | null) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

/**
 * The gateway and the harness, driven from here: the gateway is a child of QuChen (no window, no script),
 * and the harness profile is written from the live state — once, or automatically whenever the model changes.
 */
/**
 * Settings › Integrations: the free gateway, the DeepSeek Harness profile and the optional network tool.
 * A page of its own rather than a dialog on the Serving screen.
 */
export function IntegrationsPanel() {
    const [status, setStatus] = useState<Status | null>(null);
    const [pending, setPending] = useState('');
    const [error, setError] = useState('');
    const [note, setNote] = useState('');
    const [showLog, setShowLog] = useState(false);
    const file = useRef<HTMLInputElement | null>(null);
    const [paused, setPaused] = useState(false);

    async function load() {
        try {
            const next = await api.get<Status>('/api/integrations');
            setStatus(next);
            try { const serving = await api.get<{ pauseServing?: boolean }>('/api/serving'); setPaused(!!serving.pauseServing); } catch { /* older host */ }
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
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
            if (!res.ok) throw new Error((doc as { error?: string })?.error ?? '安装失败。'); setNote(tr('装好了，点「启动」即可。')); await load();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setPending(''); }
    }

    async function call(name: string, url: string, payload: Record<string, unknown>, done: string): Promise<boolean> {
        setPending(name); setError(''); setNote('');
        try {
            await api.post(url, { ...payload }); setNote(done); await load(); return true;
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
        finally { setPending(''); }
    }

    const h = status?.harness, g = status?.gateway, v = status?.vpn;
    const ready = true;

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
                        ? <Btn size="sm" icon="download" disabled={!ready || pending !== ''} onClick={() => void call('gw', '/api/integrations/gateway', { action: 'install' }, tr('免费网关装好了，点「启动」就能用。'))}>{pending === 'gw' ? tr('安装中…') : tr('安装')}</Btn>
                        : g.running
                            ? <Btn size="sm" variant="ghost" disabled={!ready || pending !== ''} onClick={() => void call('gw', '/api/integrations/gateway', { action: 'stop' }, tr('网关已停止。'))}>{tr('停止')}</Btn>
                            : <Btn size="sm" icon="bolt" disabled={!ready || pending !== ''} onClick={() => void call('gw', '/api/integrations/gateway', { action: 'start' }, tr('网关已启动（几秒后就绪）。'))}>{tr('启动')}</Btn>}
                </div>
            </div>
            {!g?.present
                ? <p className="small muted" style={{ margin: '6px 0 0' }}>{tr('第一次用点「安装」：用 QuChen 自带的 Python 在本机装好（约 2 分钟，不下载大文件），以后直接启动。')}</p>
                : <p className="small muted" style={{ margin: '6px 0' }}>{g.dir}</p>}
            {g && g.present && g.models.length ? <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {g.models.map((m) => <span key={m} className="small" style={{ border: '1px solid var(--line, #e5e7eb)', borderRadius: 999, padding: '1px 8px' }}>{m}</span>)}
            </div> : null}
            {g?.present ? <details style={{ marginTop: 8 }} open={showLog} onToggle={(e) => setShowLog((e.target as HTMLDetailsElement).open)}>
                <summary className="small">{tr('日志')}</summary>
                <pre className="small muted" style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{g?.log || '—'}</pre>
            </details> : null}
        </section>

        <section className="st-card">
            <strong>{tr('DeepSeek Harness')}</strong>
            <p className="small" style={{ margin: '6px 0' }}>
                {h?.model ? `${tr('当前模型')}: ${h.model} · ${tr('写入地址')}: ${h.baseUrl ?? '—'}` : tr('现在没有在跑的模型。')}
            </p>
            <p className="small muted" style={{ margin: '0 0 6px' }}>
                {tr('会写入')} {h?.localModels.length ?? 0} {tr('个本地模型')} · {h?.gatewayModels.length ?? 0} {tr('个网关模型')}
                {h?.lastSync ? ` · ${tr('上次同步')} ${when(h.lastSync)}` : ''}
            </p>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <label className="row small" style={{ gap: 6 }}>
                    <input type="checkbox" checked={!!h?.autoSync} disabled={!ready || pending !== ''}
                        onChange={(e) => void call('auto', '/api/integrations/auto', { on: e.target.checked }, e.target.checked ? tr('已开启：模型变化时自动同步。') : tr('已关闭自动同步。'))}/>
                    <span>{tr('自动保持同步（换模型/换端口都不用再点）')}</span>
                </label>
                <Btn size="sm" icon="refresh" disabled={!ready || pending !== '' || (!h?.model && !(h?.gatewayModels.length ?? 0))}
                    onClick={() => void call('sync', '/api/integrations/harness', {}, tr('已写入 Harness 配置，重启 Harness 后生效。'))}>{tr('立即同步')}</Btn>
            </div>
        </section>

        <section className="st-card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                    <strong>{tr('暂停模型')}</strong>
                    <p className="small muted" style={{ margin: '4px 0 0' }}>{tr('暂停后不再接受新的 API 请求，模型仍留在显存。')}</p>
                </div>
                <Btn size="sm" icon={paused ? 'play' : 'pause'} disabled={!ready || pending !== ''}
                    onClick={() => void call('pause', '/api/integrations/pause', { paused: !paused }, paused ? tr('已恢复。') : tr('已暂停。')).then((ok) => { if (ok) setPaused(!paused); })}>
                    {paused ? tr('恢复') : tr('暂停')}
                </Btn>
            </div>
        </section>


        <section className="st-card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                    <strong><Dot on={!!v?.running}/>{tr('网络工具（可选）')}</strong>
                    <span className="small muted"> QuChen VPN</span>
                </div>
                <div className="row">
                    {!v?.installed
                        ? <Btn size="sm" icon="download" disabled={!ready || pending !== ''} onClick={() => void call('vpn', '/api/integrations/vpn', { action: 'install' }, tr('装好了，点「启动」即可。'))}>{pending === 'vpn' ? tr('下载中…') : tr('下载安装')}</Btn>
                        : v.running
                            ? <Btn size="sm" variant="ghost" disabled={!ready || pending !== ''} onClick={() => void call('vpn', '/api/integrations/vpn', { action: 'stop' }, tr('已停止。'))}>{tr('停止')}</Btn>
                            : <><Btn size="sm" variant="ghost" disabled={!ready || pending !== ''} onClick={() => file.current?.click()}>{tr('从本地文件…')}</Btn><Btn size="sm" icon="bolt" disabled={!ready || pending !== ''} onClick={() => void call('vpn', '/api/integrations/vpn', { action: 'start' }, tr('已启动，看托盘图标。'))}>{tr('启动')}</Btn></>}
                </div>
            </div>
            {v?.progress && ['resolving', 'downloading', 'installing', 'unpacking'].includes(v.progress.phase)
                ? <div style={{ margin: '8px 0 0' }}>
                    <div style={{ height: 6, background: 'var(--line, #e5e7eb)', borderRadius: 999, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: (v.progress.total ? Math.min(100, Math.round(v.progress.done / v.progress.total * 100)) : 5) + '%', background: '#22c55e', transition: 'width .3s' }}/>
                    </div>
                    <p className="small muted" style={{ margin: '4px 0 0' }}>{v.progress.message}{v.progress.total ? ` · ${Math.round(v.progress.done / 1048576)} / ${Math.round(v.progress.total / 1048576)} MB` : ''}</p>
                  </div>
                : null}
            {v?.progress?.phase === 'error' ? <p className="small inline-error">{v.progress.message}</p> : null}
            <p className="small muted" style={{ margin: '6px 0 0' }}>{tr('只有需要访问 GitHub 时才用；不装也不影响聊天和网关。装的是免安装包，落在 QuChen 自己的目录里；下载失败时可以用「从本地文件…」选 QuChenVPN 的 zip 或 exe。')}</p>
            <input ref={file} type="file" accept=".zip,.exe" hidden onChange={(e) => { const picked = e.target.files?.[0]; if (!picked) return; void upload(picked); e.target.value = ''; }}/>
        </section>

        {note ? <p className="small">{note}</p> : null}
        {error ? <ErrorNotice message={error}/> : null}
        </div>
    </div>;
}
