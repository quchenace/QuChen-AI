import { tr } from '../lib/i18n';
import { Screen } from '../components/layout';
import { IntegrationsPanel } from '../components/IntegrationsPanel';

/** The free gateway gets its own place in the rail: models, the harness link and the optional network tool. */
export function GatewayScreen() {
    return <Screen title={tr('网关')} sub={tr('免费模型网关、DeepSeek Harness 同步、网络工具')} width="wide">
        <IntegrationsPanel />
    </Screen>;
}
