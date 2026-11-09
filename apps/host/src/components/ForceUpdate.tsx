import { useEffect, useState, type ReactNode } from 'react';
import { tr } from '../lib/i18n';
import { Btn, Icon } from './ui';
import { api } from '../lib/client';

type Verdict = { status: string; latestVersion?: string; releaseUrl?: string; message?: string };

/**
 * A version gate: when a newer release exists, QuChen says so and offers nothing else until it is installed.
 * The check is local to the app's own release feed; if the feed cannot be read, the app carries on.
 */
export function ForceUpdate({ children }: { children: ReactNode }) {
    const [block, setBlock] = useState<Verdict | null>(null);
    const [checking, setChecking] = useState(false);

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

    if (!block) return <>{children}</>;
    return <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'var(--bg, #fff)', display: 'grid', placeItems: 'center' }}>
        <div style={{ maxWidth: 460, padding: 28, textAlign: 'center' }}>
            <Icon name="warning" size={36}/>
            <h1 style={{ margin: '12px 0 6px', fontSize: 22 }}>{tr('需要更新到 {0}', [block.latestVersion ?? ''])}</h1>
            <p className="small muted" style={{ margin: '0 0 18px' }}>{tr('这个版本已经停止支持。更新后即可继续使用，模型和对话不受影响。')}</p>
            <div className="row" style={{ justifyContent: 'center', gap: 10 }}>
                <Btn variant="primary" icon="download" onClick={() => { if (block.releaseUrl) window.open(block.releaseUrl, '_blank'); }}>{tr('打开下载页')}</Btn>
                <Btn icon="refresh" disabled={checking} onClick={() => void check()}>{tr('重新检查')}</Btn>
            </div>
        </div>
    </div>;
}
