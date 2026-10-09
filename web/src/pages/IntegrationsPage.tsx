import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { Integration } from "@shared";
import { apiUrl, integrationsApi } from "../api/integrations";
import { confirmDialog } from "../components/dialogs";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { PageHead } from "../components/shell/PageHead";
import { copyText } from "../components/ShareDialog";
import { t } from "../i18n";
import { formatDate, relativeTime } from "../lib/format";
import { toastError } from "../lib/toast";
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

/** Health of the link with Umbrella: inactive, never synced, stale (no feed read for 1 hour) or ok. */
function syncState(i: Integration): { cls: string; label: string } {
  if (!i.active) return { cls: "", label: t("Inactive") };
  if (!i.lastFeedAt && !i.lastAlertAt)
    return { cls: "info", label: t("Waiting for Umbrella") };
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
  active: boolean;
}

function IntegrationForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Integration;
  onClose: () => void;
  onSaved: (secret?: string, integration?: Integration) => void;
}) {
  const [v, setV] = useState<FormValue>({
    title: initial?.title ?? "Umbrella",
    umbrellaUrl: initial?.umbrellaUrl ?? "",
    inventoryUrl: initial?.inventoryUrl ?? "",
    active: initial?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormValue>(k: K, val: FormValue[K]) =>
    setV((p) => ({ ...p, [k]: val }));

  const save = async () => {
    if (!v.title.trim()) return setError(t("Name is required"));
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

  return (
    <Modal
      title={initial ? t("Edit integration") : t("Connect Umbrella")}
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
        <label className="field-label">{t("Umbrella URL")}</label>
        <input
          className="input"
          placeholder="https://umbrella.corp"
          value={v.umbrellaUrl}
          onChange={(e) => set("umbrellaUrl", e.target.value)}
        />
        <div className="muted small">
          {t("Used to build links back to Umbrella (optional).")}
        </div>
        <label className="field-label">{t("Inventory DB public URL")}</label>
        <input
          className="input"
          placeholder={window.location.origin}
          value={v.inventoryUrl}
          onChange={(e) => set("inventoryUrl", e.target.value)}
        />
        <div className="muted small">
          {t(
            "Used for record links in the CMDB feed. Defaults to the address Umbrella calls.",
          )}
        </div>
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
  const unmatched = useQuery({
    queryKey: [...KEY, i.id, "unmatched"],
    queryFn: () => integrationsApi.unmatched(i.id),
    enabled: showUnmatched,
  });
  const state = syncState(i);
  const feed = apiUrl(i, `/integrations/${i.id}/umbrella/ci`);
  const hook = apiUrl(i, `/integrations/${i.id}/umbrella/alerts`);

  const rotate = async () => {
    const ok = await confirmDialog({
      title: t("Issue a new signing secret?"),
      message: t(
        "Umbrella must be updated with the new secret; until then its alert deliveries are rejected.",
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
      message: t(
        "Umbrella will no longer be able to read the feed or send alerts. Stored alert states are deleted.",
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
          <b>{t("Copy the signing secret now — it won’t be shown again.")}</b>
          <CopyField value={secret} />
        </div>
      )}

      <dl className="integration-details">
        <dt>{t("CMDB feed (Inventory connector)")}</dt>
        <dd>
          <CopyField value={feed} />
          <div className="muted small">
            {t(
              "Umbrella pulls this every 15 minutes with an API token of a read-only user in the",
            )}{" "}
            <code>xc-token</code> {t("header, paging by")} <code>offset</code>{" "}
            {t("until")} <code>next_offset</code> {t("is null.")}{" "}
            <Link to="/admin/tokens">{t("Create an API token")}</Link>
          </div>
        </dd>
        <dt>{t("Alert webhook (Status connector)")}</dt>
        <dd>
          <CopyField value={hook} />
          <div className="muted small">
            {t("Signed with the secret:")} <code>x-umbrella-timestamp</code>,{" "}
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
            <dt>{t("Umbrella")}</dt>
            <dd>
              <a href={i.umbrellaUrl} target="_blank" rel="noreferrer noopener">
                {i.umbrellaUrl}
              </a>
            </dd>
          </>
        )}
      </dl>

      <button className="link-btn" onClick={() => setShowUnmatched((s) => !s)}>
        <Icon name={showUnmatched ? "chevronDown" : "chevronRight"} size={13} />{" "}
        {t("Unmatched alerts")}
      </button>
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

/** Integrations section: connect Inventory DB with Umbrella monitoring (docs/integrations.md). */
export function IntegrationsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: KEY, queryFn: integrationsApi.list });
  const [creating, setCreating] = useState(false);
  // Secrets are shown once, right after creation or rotation; kept only in memory.
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  return (
    <main className="content page integrations-page">
      <PageHead
        title={t("Integrations")}
        subtitle={t(
          "Umbrella monitoring reads sites, racks and devices from Inventory DB as configuration items of its CMDB map, and sends alert states back so devices show their monitoring status.",
        )}
        actions={
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={15} /> {t("Connect Umbrella")}
          </button>
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
              "Connect Umbrella to share the inventory with monitoring and see alert states on devices.",
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
          onClose={() => setCreating(false)}
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
