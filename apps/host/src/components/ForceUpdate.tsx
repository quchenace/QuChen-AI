import { useEffect, useState, type ReactNode } from 'react';
import { tr } from '../lib/i18n';
import { Btn, Icon } from './ui';
import { api } from '../lib/client';
import { openExternal } from '../lib/open-external';

type Verdict = { status: string; latestVersion?: string; releaseUrl?: string; message?: string };
type Progress = { phase: string; done: number; total: number; message: string; version?: string };

const RELEASES_PAGE = 'https://github.com/quchenace/QuChen-AI/releases/latest';

const PHASE_LABEL: Record<string, string> = {
    manifest: '正在读取版本信息',
    downloading: '正在下载安装包',
    verifying: '正在核对安装包',
    installing: '正在安装',
    done: '安装程序已启动',
    error: '更新没有完成',
};

function size(n: number) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
}

/**
 * A version gate: when a newer release exists, QuChen says so and offers nothing else until it is installed.
 * The check is local to the app's own release feed; if the feed cannot be read, the app carries on.
 *
 * "下载并安装" runs the whole thing in place — download, checksum, silent install — and the page follows
 * `/api/app/update/progress` while it runs, so a 100 MB download shows bytes and a bar instead of silence.
 */
export function ForceUpdate({ children }: { children: ReactNode }) {
    const [block, setBlock] = useState<Verdict | null>(null);
    const [checking, setChecking] = useState(false);
    const [working, setWorking] = useState(false);
    const [progress, setProgress] = useState<Progress | null>(null);
    const [failure, setFailure] = useState('');

    async function check() {
        setChecking(true);
        try {
            const doc = await api.get<{ quchen?: Verdict }>('/api/updates/check');
            const q = doc?.quchen;
            setBlock(q && q.status === 'available' ? q : null);
        } catch { setBlock(null); }
        finally { setChecking(false); }
    }
    useEffect(() => { void check(); }, []);

    // One poll per second while an update runs: the install request itself stays open for minutes and
    // would show nothing, and the host exits when the installer takes over.
    useEffect(() => {
        if (!working) return;
        let alive = true;
        const tick = async () => {
            try {
                const p = await api.get<Progress>('/api/app/update/progress');
                if (!alive) return;
                setProgress(p);
                if (p.phase === 'error') { setFailure(p.message || '更新没有完成。'); setWorking(false); }
                if (p.phase === 'done') setWorking(false);
            } catch { /* the host is restarting, the next tick finds it */ }
        };
        void tick();
        const id = setInterval(() => void tick(), 1000);
        return () => { alive = false; clearInterval(id); };
    }, [working]);

    async function install() {
        setFailure('');
        setWorking(true);
        setProgress({ phase: 'manifest', done: 0, total: 0, message: '正在读取版本信息' });
        try {
            await api.post('/api/app/update/install');
        } catch (e) {
            // The host exits 1.5 s after the installer starts, which kills this request: what counts is
            // what the progress endpoint last said, not the broken connection.
            const p = await api.get<Progress>('/api/app/update/progress').catch(() => null);
            if (p?.phase === 'done' || p?.phase === 'installing') return;
            setFailure(p?.phase === 'error' ? p.message : (e as Error).message);
            setWorking(false);
        }
    }

    if (!block) return <>{children}</>;

    const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;
    const running = working || progress?.phase === 'installing';
    return <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'var(--bg, #fff)', display: 'grid', placeItems: 'center' }}>
        <div style={{ maxWidth: 460, padding: 28, textAlign: 'center' }}>
            <Icon name="warning" size={36}/>
            <h1 style={{ margin: '12px 0 6px', fontSize: 22 }}>{tr('需要更新到 {0}', [block.latestVersion ?? ''])}</h1>
            <p className="small muted" style={{ margin: '0 0 18px' }}>{tr('这个版本已经停止支持。更新后即可继续使用，模型和对话不受影响。')}</p>

            {(progress || failure) && <div style={{ margin: '0 0 18px', textAlign: 'left' }}>
                <div className="small" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                    <span>{failure ? failure : (progress?.message || PHASE_LABEL[progress?.phase ?? ''] || '')}</span>
                    <span className="muted">{pct !== null && !failure ? pct + '%' : ''}</span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--line, #e6e6e6)', overflow: 'hidden' }}>
                    <div style={{
                        height: '100%',
                        width: (failure ? 100 : pct ?? 8) + '%',
                        background: failure ? 'var(--danger, #d9534f)' : 'var(--accent, #2b6fff)',
                        transition: 'width .35s ease',
                    }}/>
                </div>
                {progress && !failure && progress.phase === 'downloading' && <div className="small muted" style={{ marginTop: 6 }}>
                    {size(progress.done)}{progress.total ? ' / ' + size(progress.total) : ''}
                </div>}
                {failure && <div className="small muted" style={{ marginTop: 6 }}>{tr('重试一次，或者用下面的下载页手动安装。')}</div>}
            </div>}

            <div className="row" style={{ justifyContent: 'center', gap: 10 }}>
                <Btn variant="primary" icon="download" disabled={running} onClick={() => void install()}>
                    {tr(running ? '正在更新…' : failure ? '重试下载并安装' : '下载并安装')}
                </Btn>
                <Btn icon="link" onClick={() => { void openExternal(block.releaseUrl || RELEASES_PAGE); }}>{tr('下载页')}</Btn>
                <Btn icon="refresh" disabled={checking || running} onClick={() => void check()}>{tr('重新检查')}</Btn>
            </div>
        </div>
    </div>;
}
