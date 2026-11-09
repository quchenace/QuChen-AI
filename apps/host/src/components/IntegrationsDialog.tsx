import { useEffect, useState } from 'react';
import { Btn, Dialog, ErrorNotice } from './ui';
import { api } from '../lib/client';
import { tr } from '../lib/i18n';

type Harness = {
    profile: string; exists: boolean; current: string | null;
    model: string | null; port: number | null; baseUrl: string | null; via: string;
};
type Gateway = { dir: string; present: boolean; running: boolean; port: number };
type Status = { harness: Harness; gateway: Gateway };

/**
 * One place for the three things that used to need a hand-edited file:
 * pointing the DeepSeek Harness at this app, starting the free-model gateway, and pausing the model.
 * Every action asks for the passcode first.
 */
export function IntegrationsDialog({ open, onClose, paused, onPaused }: {
    open: boolean;
    onClose: () => void;
    paused: boolean;
    onPaused: (paused: boolean) => void;
}) {
    const [status, setStatus] = useState<Status | null>(null);
    const [passcode, setPasscode] = useState('');
    const [withGateway, setWithGateway] = useState(true);
    const [pending, setPending] = useState('');
    const [error, setError] = useState('');
    const [note, setNote] = useState('');

    async function load() {
        try { setStatus(await api.get<Status>('/api/integrations')); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }
    useEffect(() => { if (open) { setError(''); setNote(''); void load(); } }, [open]);

    async function run(name: string, action: () => Promise<unknown>, done: string) {
        setPending(name); setError(''); setNote('');
        try { await action(); setNote(done); await load(); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setPending(''); }
    }

    const ready = passcode.trim().length > 0;
    const h = status?.harness, g = status?.gateway;

    return <Dialog open={open} onClose={onClose} title={tr('集成与一键同步')} wide
        actions={<Btn onClick={onClose}>{tr('Close')}</Btn>}>
        <div className="stack">
            <label className="field">
                <span className="field__label">{tr('口令')}</span>
                <input className="input" type="password" value={passcode} autoComplete="off"
                    placeholder={tr('输入口令后才可以使用下面的功能')}
                    onChange={(e) => setPasscode(e.target.value)}/>
            </label>

            <section className="card">
                <h3 className="card__title">{tr('DeepSeek Harness 同步')}</h3>
                <p className="small muted">
                    {h ? `${tr('配置')}: ${h.profile}` : tr('读取中…')}
                </p>
                <p className="small">
                    {h?.model ? `${tr('当前模型')}: ${h.model}  ·  ${tr('端口')}: ${h.port ?? '-'}` : tr('QuChen 还没有在跑的模型。')}
                </p>
                <p className="small muted">
                    {h?.baseUrl ? `${tr('将写入地址')}: ${h.baseUrl} (${h.via})` : tr('还没有可用的 API 地址。')}
                </p>
                <label className="row small">
                    <input type="checkbox" checked={withGateway} onChange={(e) => setWithGateway(e.target.checked)}/>
                    <span>{tr('同时把免费网关加进去')}</span>
                </label>
                <div className="row">
                    <Btn icon="bolt" disabled={!ready || pending !== ''}
                        onClick={() => void run('sync', () => api.post('/api/integrations/harness', { password: passcode.trim(), withGateway }), tr('已写入 Harness 配置，重启 Harness 后生效。'))}>
                        {pending === 'sync' ? tr('写入中…') : tr('一键同步到 Harness')}
                    </Btn>
                </div>
            </section>

            <section className="card">
                <h3 className="card__title">{tr('免费网关 (LiteLLM)')}</h3>
                <p className="small muted">{g ? g.dir : ''}</p>
                <p className="small">{g?.running ? tr('运行中 · 127.0.0.1:4000') : tr('未运行')}</p>
                <div className="row">
                    <Btn disabled={!ready || pending !== '' || !g?.present}
                        onClick={() => void run('gw-start', () => api.post('/api/integrations/gateway', { password: passcode.trim(), action: 'start' }), tr('网关已启动（约 20 秒后就绪）。'))}>
                        {tr('启动网关')}
                    </Btn>
                    <Btn variant="ghost" disabled={!ready || pending !== ''}
                        onClick={() => void run('gw-stop', () => api.post('/api/integrations/gateway', { password: passcode.trim(), action: 'stop' }), tr('网关已停止。'))}>
                        {tr('停止网关')}
                    </Btn>
                </div>
            </section>

            <section className="card">
                <h3 className="card__title">{tr('暂停模型')}</h3>
                <p className="small muted">{tr('暂停后不再接受新的 API 请求，模型仍留在显存里；恢复即可继续。')}</p>
                <div className="row">
                    <Btn icon="pause" disabled={!ready || pending !== ''}
                        onClick={() => void run('pause', async () => { await api.post('/api/integrations/pause', { password: passcode.trim(), paused: !paused }); onPaused(!paused); }, paused ? tr('已恢复。') : tr('已暂停。'))}>
                        {paused ? tr('恢复模型') : tr('暂停模型')}
                    </Btn>
                    {paused ? <span className="small muted">{tr('当前：已暂停')}</span> : null}
                </div>
            </section>

            {note ? <p className="small">{note}</p> : null}
            {error ? <ErrorNotice message={error}/> : null}
        </div>
    </Dialog>;
}
