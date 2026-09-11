import { AddressText } from '~/components/ui/address';
import { Badge, type BadgeProps } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Panel, PanelBody, PanelHeader } from '~/components/ui/panel';
import { ErrorNotice } from '~/components/ui/state';
import { formatValidity, useAgentWallet } from '~/hooks/useAgentWallet';
import { useAuth } from '~/hooks/useAuth';
import { cn } from '~/lib/utils';

/**
 * Trading authorization panel.
 *
 * Copy trading needs a Hyperliquid agent wallet (API wallet) that this platform
 * may use to place orders for the user's account. The permission is granted by
 * the user's own wallet and is enforced by the exchange: an agent can trade, but
 * it can never transfer funds or withdraw. That distinction is the whole point
 * of the model, so the UI states it plainly rather than hiding it in docs.
 *
 * The panel is intentionally explicit about the three states a user can be in —
 * not connected, connected but unauthorized, authorized (possibly expiring) —
 * because "why did my strategy stop trading" is almost always an expired
 * authorization. Each state gets its own badge, tone and call to action.
 */

interface AuthState {
  variant: NonNullable<BadgeProps['variant']>;
  badge: string;
  message: string;
  tone: 'neutral' | 'warning' | 'up';
  /** Only the authorized states offer a call to action. */
  actionable: boolean;
}

const MESSAGE_TONE: Readonly<Record<AuthState['tone'], string>> = Object.freeze({
  neutral: 'text-fg-secondary',
  warning: 'text-warning',
  up: 'text-fg-secondary',
});

function resolveAuthState(input: {
  isConnected: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
  approved: boolean;
  expiringSoon: boolean;
}): AuthState {
  if (!input.isConnected) {
    return {
      variant: 'outline',
      badge: 'Wallet disconnected',
      message: 'Connect your wallet to authorize copy trading for your account.',
      tone: 'neutral',
      actionable: false,
    };
  }
  if (!input.isAuthenticated) {
    return {
      variant: 'warning',
      badge: 'Sign in required',
      message: 'Sign in with your wallet to authorize copy trading.',
      tone: 'warning',
      actionable: false,
    };
  }
  if (input.isLoading) {
    return {
      variant: 'neutral',
      badge: 'Checking…',
      message: 'Checking whether this account has an active trading agent.',
      tone: 'neutral',
      actionable: false,
    };
  }
  if (input.approved && input.expiringSoon) {
    return {
      variant: 'warning',
      badge: 'Expiring soon',
      message:
        'The agent is authorized, but the authorization expires soon. Re-authorize to keep copying without interruption.',
      tone: 'warning',
      actionable: true,
    };
  }
  if (input.approved) {
    return {
      variant: 'up',
      badge: 'Authorized',
      message:
        'HyperDash can place and cancel orders on your behalf. It cannot transfer your funds or withdraw them.',
      tone: 'up',
      actionable: true,
    };
  }
  return {
    variant: 'neutral',
    badge: 'Not authorized',
    message: 'Authorize a trading agent so HyperDash can copy trades into your account.',
    tone: 'neutral',
    actionable: true,
  };
}

const STEP_LABEL: Readonly<Record<string, string>> = Object.freeze({
  preparing: 'Preparing the authorization…',
  signing: 'Waiting for your wallet to sign…',
  confirming: 'Confirming with the exchange…',
});

export function AgentWalletCard() {
  const { isConnected, isAuthenticated } = useAuth();
  const { status, isLoading, isWorking, step, error, approve, revoke } = useAgentWallet();

  const approved = status?.approved ?? false;
  const expiry = status ? formatValidity(status.validUntil) : null;

  const state = resolveAuthState({
    isConnected,
    isAuthenticated,
    isLoading: isLoading && isConnected && isAuthenticated,
    approved,
    expiringSoon: status?.expiringSoon ?? false,
  });

  const buttonLabel = approved ? 'Re-authorize' : 'Authorize copy trading';

  return (
    <Panel>
      <PanelHeader
        title="Trading authorization"
        actions={<Badge variant={state.variant}>{state.badge}</Badge>}
      />
      <PanelBody className="space-y-3">
        <p className={cn('text-sm', MESSAGE_TONE[state.tone])} role="status">
          {state.message}
        </p>

        {isConnected && isAuthenticated && !isLoading ? (
          <dl className="space-y-1 text-xs">
            {status?.agentAddress ? (
              <div className="flex min-w-0 items-center gap-2">
                <dt className="shrink-0 text-fg-tertiary">Agent wallet</dt>
                <dd className="min-w-0">
                  <AddressText address={status.agentAddress} />
                </dd>
              </div>
            ) : null}
            {approved ? (
              <div className="flex items-center gap-2">
                <dt className="shrink-0 text-fg-tertiary">Valid until</dt>
                <dd className="text-fg-secondary">{expiry ?? 'No expiry'}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {isWorking ? (
          <p className="text-xs text-fg-tertiary" role="status">
            {STEP_LABEL[step] ?? 'Working…'}
          </p>
        ) : null}

        {error ? <ErrorNotice message={error} /> : null}

        {state.actionable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="md"
              disabled={isWorking}
              onClick={() => {
                // The message is already captured in the hook's `error`, which is
                // rendered above; catching here only prevents an unhandled
                // rejection when the wallet prompt is dismissed.
                void approve().catch(() => undefined);
              }}
            >
              {isWorking ? (STEP_LABEL[step] ?? 'Working…') : buttonLabel}
            </Button>
            {approved ? (
              <Button
                variant="outline"
                size="md"
                disabled={isWorking}
                onClick={() => {
                  void revoke().catch(() => undefined);
                }}
              >
                Revoke
              </Button>
            ) : null}
          </div>
        ) : null}

        <p className="border-t border-border pt-3 text-xs text-fg-tertiary">
          An agent wallet can place and cancel orders, but it can never transfer funds or withdraw
          them — that limit is enforced by Hyperliquid, not by HyperDash. Authorizing is a
          signature, not a transaction: no gas and no network switch.
        </p>
      </PanelBody>
    </Panel>
  );
}
