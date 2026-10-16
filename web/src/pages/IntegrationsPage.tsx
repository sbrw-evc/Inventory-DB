import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { Integration, IntegrationKind } from "@shared";
import { apiUrl, integrationsApi } from "../api/integrations";
import { confirmDialog } from "../components/dialogs";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { PageHead } from "../components/shell/PageHead";
import { copyText } from "../components/ShareDialog";
import { t } from "../i18n";
import { formatDate, relativeTime } from "../lib/format";
import { toastError } from "../lib/toast";
import { useMe } from "../netbox/hooks";
import "./integrations.css";

const KEY = ["integrations"] as const;

/** A value with a copy button (URLs, secrets). */
function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <div className="share-link">
      <input
        className={`input ${mono ? "mono" : ""}`}
        readOnly
        value={value}
        onFocus={(e) => e.target.select()}
      />
      <button
        type="button"
        className="btn"
        onClick={() => copyText(value)}
        title={t("Copy")}
      >
        <Icon name="copy" size={13} /> {t("Copy")}
      </button>
    </div>
  );
}

function When({ iso, never }: { iso?: string | null; never: string }) {
  if (!iso) return <span className="muted">{never}</span>;
  return <span title={formatDate(iso, true)}>{relativeTime(iso)}</span>;
}

/** Health of the link with Beacon: inactive, never synced, stale (no feed read for 1 hour) or ok. */
function syncState(i: Integration): { cls: string; label: string } {
  if (!i.active) return { cls: "", label: t("Inactive") };
  if (i.kind === "flow") {
    if (!i.lastDelivery)
      return { cls: "info", label: t("No changes sent yet") };
    return i.lastDelivery.ok
      ? { cls: "ok", label: t("Connected") }
      : { cls: "error", label: t("Last delivery failed") };
  }
  if (!i.lastFeedAt && !i.lastAlertAt)
    return { cls: "info", label: t("Waiting for Beacon") };
  const age = i.lastFeedAt
    ? Date.now() - new Date(i.lastFeedAt).getTime()
    : Infinity;
  if (age > 60 * 60 * 1000)
    return { cls: "warning", label: t("Feed not read recently") };
  return { cls: "ok", label: t("Connected") };
}

interface FormValue {
  title: string;
  umbrellaUrl: string;
  inventoryUrl: string;
  flowUrl: string;
  flowToken: string;
  active: boolean;
}

function IntegrationForm({
  initial,
  kind = initial?.kind ?? "umbrella",
  onClose,
  onSaved,
}: {
  initial?: Integration;
  kind?: IntegrationKind;
  onClose: () => void;
  onSaved: (secret?: string, integration?: Integration) => void;
}) {
  const isFlow = kind === "flow";
  const [v, setV] = useState<FormValue>({
    title: initial?.title ?? (isFlow ? "Current" : "Beacon"),
    umbrellaUrl: initial?.umbrellaUrl ?? "",
    inventoryUrl: initial?.inventoryUrl ?? "",
    flowUrl: initial?.flowUrl ?? "",
    flowToken: "",
    active: initial?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormValue>(k: K, val: FormValue[K]) =>
    setV((p) => ({ ...p, [k]: val }));

  const save = async () => {
    if (!v.title.trim()) return setError(t("Name is required"));
    if (isFlow) return saveFlow();
    for (const u of [v.umbrellaUrl, v.inventoryUrl]) {
      if (u.trim() && !/^https?:\/\/\S+$/i.test(u.trim()))
        return setError(t("URLs must start with http:// or https://"));
    }
    setBusy(true);
    setError(null);
    const body = {
      title: v.title.trim(),
      active: v.active,
      umbrellaUrl: v.umbrellaUrl.trim() || null,
      inventoryUrl: v.inventoryUrl.trim() || null,
    };
    try {
      if (initial) {
        onSaved(undefined, await integrationsApi.update(initial.id, body));
      } else {
        const res = await integrationsApi.create({ kind: "umbrella", ...body });
        onSaved(res.secret, res.integration);
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveFlow = async () => {
    if (!/^https?:\/\/\S+$/i.test(v.flowUrl.trim()))
      return setError(t("URLs must start with http:// or https://"));
    if (!initial && !v.flowToken.trim())
      return setError(t("The Current API token is required"));
    setBusy(true);
    setError(null);
    const body = {
      title: v.title.trim(),
      active: v.active,
      flowUrl: v.flowUrl.trim(),
      ...(v.flowToken.trim() ? { flowToken: v.flowToken.trim() } : {}),
    };
    try {
      if (initial) {
        onSaved(undefined, await integrationsApi.update(initial.id, body));
      } else {
        const res = await integrationsApi.create({ kind: "flow", ...body });
        onSaved(res.secret, res.integration);
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={
        initial
          ? t("Edit integration")
          : isFlow
            ? t("Connect Current")
            : t("Connect Beacon")
      }
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy
              ? t("Saving…")
              : initial
                ? t("Save")
                : t("Create integration")}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field-label">{t("Name")}</label>
        <input
          className="input"
          autoFocus
          value={v.title}
          onChange={(e) => set("title", e.target.value)}
        />
        {isFlow ? (
          <>
            <label className="field-label">{t("Current URL")}</label>
            <input
              className="input"
              placeholder="https://flow.corp"
              value={v.flowUrl}
              onChange={(e) => set("flowUrl", e.target.value)}
            />
            <label className="field-label">{t("Current API token")}</label>
            <input
              className="input mono"
              type="password"
              autoComplete="off"
              placeholder={
                initial?.flowTokenSet
                  ? t("Stored — leave empty to keep it")
                  : "flow_…"
              }
              value={v.flowToken}
              onChange={(e) => set("flowToken", e.target.value)}
            />
            <div className="muted small">
              {t(
                "A Current token with integrations.inventory:read. It is kept in the secret store (OpenBao) and never sent to browsers.",
              )}
            </div>
          </>
        ) : (
          <>
            <label className="field-label">{t("Beacon URL")}</label>
            <input
              className="input"
              placeholder="https://umbrella.corp"
              value={v.umbrellaUrl}
              onChange={(e) => set("umbrellaUrl", e.target.value)}
            />
            <div className="muted small">
              {t("Used to build links back to Beacon (optional).")}
            </div>
            <label className="field-label">
              {t("Ledger public URL")}
            </label>
            <input
              className="input"
              placeholder={window.location.origin}
              value={v.inventoryUrl}
              onChange={(e) => set("inventoryUrl", e.target.value)}
            />
            <div className="muted small">
              {t(
                "Used for record links in the CMDB feed. Defaults to the address Beacon calls.",
              )}
            </div>
          </>
        )}
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={v.active}
            onChange={(e) => set("active", e.target.checked)}
          />{" "}
          {t("Active")}
        </label>
      </div>
      {error && <div className="notice notice-error">{error}</div>}
    </Modal>
  );
}

function IntegrationCard({
  integration: i,
  secret,
  onSecret,
}: {
  integration: Integration;
  secret?: string;
  onSecret: (s: string) => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const isFlow = i.kind === "flow";
  const unmatched = useQuery({
    queryKey: [...KEY, i.id, "unmatched"],
    queryFn: () => integrationsApi.unmatched(i.id),
    enabled: showUnmatched && !isFlow,
  });
  const state = syncState(i);
  const feed = apiUrl(i, `/integrations/${i.id}/umbrella/ci`);
  const hook = apiUrl(i, `/integrations/${i.id}/umbrella/alerts`);

  const rotate = async () => {
    const ok = await confirmDialog({
      title: t("Issue a new signing secret?"),
      message: isFlow
        ? t(
            "Paste the new secret into Current within 24 hours; until then change notifications carry signatures with both secrets.",
          )
        : t(
            "Beacon must be updated with the new secret; until then its alert deliveries are rejected.",
          ),
      confirmLabel: t("Rotate secret"),
      danger: true,
    });
    if (!ok) return;
    try {
      onSecret((await integrationsApi.rotateSecret(i.id)).secret);
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: t("Delete integration “{name}”?", { name: i.title }),
      message: isFlow
        ? t(
            "Traffic from Current disappears from DCIM pages and Current is no longer notified of changes. The stored Current token is deleted.",
          )
        : t(
            "Beacon will no longer be able to read the feed or send alerts. Stored alert states are deleted.",
          ),
      confirmLabel: t("Delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await integrationsApi.remove(i.id);
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      toastError(e);
    }
  };
  const toggle = async () => {
    try {
      await integrationsApi.update(i.id, { active: !i.active });
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <section className="integration-card">
      <header className="integration-card-head">
        <Icon name="plug" size={18} />
        <h2>{i.title}</h2>
        <span className={`status-chip ${state.cls}`}>{state.label}</span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={toggle}>
          {i.active ? t("Deactivate") : t("Activate")}
        </button>
        <button className="btn btn-sm" onClick={() => setEditing(true)}>
          <Icon name="edit" size={13} /> {t("Edit")}
        </button>
        <button className="btn btn-sm btn-danger-outline" onClick={remove}>
          <Icon name="trash" size={13} /> {t("Delete")}
        </button>
      </header>

      {isFlow ? (
        <FlowDetails integration={i} secret={secret} onRotate={rotate} />
      ) : (
        <>
          <div className="counters integration-counters">
            <div className="counter neutral">
              <span className="counter-label">{t("Last CMDB sync")}</span>
              <span className="counter-value">
                <When iso={i.lastFeedAt} never={t("never")} />
              </span>
              {i.lastFeedCount != null && (
                <span className="muted small">
                  {t("{n} configuration items", { n: i.lastFeedCount })}
                </span>
              )}
            </div>
            <div className="counter neutral">
              <span className="counter-label">{t("Last alert received")}</span>
              <span className="counter-value">
                <When iso={i.lastAlertAt} never={t("never")} />
              </span>
            </div>
            <div className="counter neutral">
              <span className="counter-label">{t("Created")}</span>
              <span className="counter-value">
                {formatDate(i.createdAt, false)}
              </span>
            </div>
          </div>

          {secret && (
            <div className="notice notice-success token-once">
              <b>
                {t("Copy the signing secret now — it won’t be shown again.")}
              </b>
              <CopyField value={secret} />
            </div>
          )}

          <dl className="integration-details">
            <dt>{t("CMDB feed (Inventory connector)")}</dt>
            <dd>
              <CopyField value={feed} />
              <div className="muted small">
                {t(
                  "Beacon pulls this every 15 minutes with an API token of a read-only user in the",
                )}{" "}
                <code>xc-token</code> {t("header, paging by")}{" "}
                <code>offset</code> {t("until")} <code>next_offset</code>{" "}
                {t("is null.")}{" "}
                <Link to="/admin/tokens">{t("Create an API token")}</Link>
              </div>
            </dd>
            <dt>{t("Alert webhook (Status connector)")}</dt>
            <dd>
              <CopyField value={hook} />
              <div className="muted small">
                {t("Signed with the secret:")} <code>x-umbrella-timestamp</code>
                ,{" "}
                <code>
                  x-umbrella-signature: v1=HMAC-SHA256(secret, "timestamp.body")
                </code>
              </div>
            </dd>
            <dt>{t("Signing secret")}</dt>
            <dd>
              <span className="mono muted">••••••••••••</span>{" "}
              <button className="btn btn-sm" onClick={rotate}>
                <Icon name="refresh" size={13} /> {t("Rotate secret")}
              </button>
            </dd>
            {i.umbrellaUrl && (
              <>
                <dt>{t("Beacon")}</dt>
                <dd>
                  <a
                    href={i.umbrellaUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {i.umbrellaUrl}
                  </a>
                </dd>
              </>
            )}
          </dl>

          {!isFlow && (
            <button
              className="link-btn"
              onClick={() => setShowUnmatched((s) => !s)}
            >
              <Icon
                name={showUnmatched ? "chevronDown" : "chevronRight"}
                size={13}
              />{" "}
              {t("Unmatched alerts")}
            </button>
          )}
          {showUnmatched && (
            <div className="integration-unmatched">
              {unmatched.isLoading && (
                <div className="empty-hint">{t("Loading…")}</div>
              )}
              {unmatched.data && !unmatched.data.length && (
                <div className="empty-hint">
                  {t("Every alert matched a device.")}
                </div>
              )}
              {!!unmatched.data?.length && (
                <div className="table-card">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>{t("Alert")}</th>
                        <th>{t("Configuration item")}</th>
                        <th>{t("Received")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unmatched.data.map((a) => (
                        <tr key={a.alertId}>
                          <td>{a.title}</td>
                          <td className="mono small">
                            {a.ci.name ??
                              a.ci.identities?.hostname ??
                              a.ci.source_refs?.join(", ") ??
                              "—"}
                          </td>
                          <td>
                            <When iso={a.receivedAt} never="" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {editing && (
        <IntegrationForm
          initial={i}
          onClose={() => setEditing(false)}
          onSaved={() => void qc.invalidateQueries({ queryKey: KEY })}
        />
      )}
    </section>
  );
}

/** Kind `flow`: change notifications to Current, the signing secret and the stored token. */
function FlowDetails({
  integration: i,
  secret,
  onRotate,
}: {
  integration: Integration;
  secret?: string;
  onRotate: () => void;
}) {
  const d = i.lastDelivery;
  const hook = `${(i.flowUrl ?? "").replace(/\/+$/, "")}/api/integrations/inventory-db/hook`;
  return (
    <>
      <div className="counters integration-counters">
        <div className="counter neutral">
          <span className="counter-label">{t("Last change notification")}</span>
          <span className="counter-value">
            <When iso={d?.at} never={t("never")} />
          </span>
          {d && (
            <span className={`muted small ${d.ok ? "" : "text-error"}`}>
              {d.ok
                ? t("Delivered: {n} changes", { n: d.events })
                : t("Failed after {n} attempts: {error}", {
                    n: d.attempts,
                    error: d.error ?? "",
                  })}
            </span>
          )}
        </div>
        <div className="counter neutral">
          <span className="counter-label">{t("Created")}</span>
          <span className="counter-value">
            {formatDate(i.createdAt, false)}
          </span>
        </div>
      </div>

      {secret && (
        <div className="notice notice-success token-once">
          <b>{t("Copy the signing secret now — it won’t be shown again.")}</b>
          <CopyField value={secret} />
          <div className="muted small">
            {t("Store it in Current (OpenBao) as the Ledger hook secret.")}
          </div>
        </div>
      )}

      <dl className="integration-details">
        <dt>{t("Current")}</dt>
        <dd>
          {i.flowUrl && (
            <a href={i.flowUrl} target="_blank" rel="noreferrer noopener">
              {i.flowUrl}
            </a>
          )}
          <div className="muted small">
            {t(
              "DCIM pages show traffic from Current: devices, interfaces, circuits (95th percentile against the commit) and active addresses of prefixes.",
            )}
          </div>
        </dd>
        <dt>{t("Change notifications")}</dt>
        <dd>
          <CopyField value={hook} />
          <div className="muted small">
            {t(
              "Every DCIM, IPAM and circuits change is sent here, at most once every 5 seconds, signed with the secret:",
            )}{" "}
            <code>x-inventory-timestamp</code>,{" "}
            <code>
              x-inventory-signature: v1=HMAC-SHA256(secret, "timestamp.body")
            </code>
          </div>
        </dd>
        <dt>{t("Signing secret")}</dt>
        <dd>
          <span className="mono muted">••••••••••••</span>{" "}
          <button className="btn btn-sm" onClick={onRotate}>
            <Icon name="refresh" size={13} /> {t("Rotate secret")}
          </button>
        </dd>
        <dt>{t("Current API token")}</dt>
        <dd>
          {i.flowTokenSet ? (
            <span className="muted">
              {t("Stored in the secret store; never sent to browsers.")}
            </span>
          ) : (
            <span className="status-chip warning">{t("Not set")}</span>
          )}
        </dd>
        <dt>{t("Interface matching")}</dt>
        <dd className="muted small">
          {t(
            "Fill the custom field snmp_index of interfaces with their ifIndex so Current matches flow records to them.",
          )}
        </dd>
      </dl>
    </>
  );
}

/** Integrations section: connect Ledger with Beacon and Current (docs/integrations.md). */
export function IntegrationsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: KEY, queryFn: integrationsApi.list });
  const [creating, setCreating] = useState<IntegrationKind | null>(null);
  // Current is installation-wide: only DCIM/IPAM admins connect and manage it.
  const isAdmin = useMe().data?.is_admin ?? false;
  // Secrets are shown once, right after creation or rotation; kept only in memory.
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  return (
    <main className="content page integrations-page">
      <PageHead
        title={t("Integrations")}
        subtitle={t(
          "Beacon reads sites, racks and devices from Ledger as configuration items of its CMDB map, and sends alert states back so devices show their monitoring status. Current shows traffic on devices, interfaces, circuits and prefixes.",
        )}
        actions={
          <>
            {isAdmin && (
              <button className="btn" onClick={() => setCreating("flow")}>
                <Icon name="plus" size={15} /> {t("Connect Current")}
              </button>
            )}
            <button
              className="btn btn-primary"
              onClick={() => setCreating("umbrella")}
            >
              <Icon name="plus" size={15} /> {t("Connect Beacon")}
            </button>
          </>
        }
      />
      {list.isLoading && <div className="empty-hint">{t("Loading…")}</div>}
      {list.isError && (
        <div className="notice notice-error">
          {(list.error as Error).message}
        </div>
      )}
      {list.data && !list.data.length && (
        <div className="empty-state">
          <Icon name="plug" size={32} />
          <h3>{t("No integrations yet")}</h3>
          <p className="muted">
            {t(
              "Connect Beacon to share the inventory with monitoring and see alert states on devices.",
            )}
          </p>
        </div>
      )}
      {list.data?.map((i) => (
        <IntegrationCard
          key={i.id}
          integration={i}
          secret={secrets[i.id]}
          onSecret={(s) => setSecrets((p) => ({ ...p, [i.id]: s }))}
        />
      ))}
      {creating && (
        <IntegrationForm
          kind={creating}
          onClose={() => setCreating(null)}
          onSaved={(secret, integration) => {
            if (secret && integration)
              setSecrets((p) => ({ ...p, [integration.id]: secret }));
            void qc.invalidateQueries({ queryKey: KEY });
          }}
        />
      )}
    </main>
  );
}
