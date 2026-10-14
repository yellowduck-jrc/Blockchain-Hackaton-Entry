# Complete Emergency Pot delivered file contents

Final implementation, tests, public configuration example and reports. This container excludes itself, .env.local credentials and durable payment records.

## .gitignore

````text
node_modules/
.next/
.env*
!.env.example
*.tsbuildinfo

# Durable local emergency request/payment evidence; never commit signatures.
.data/

````

## .env.example

````text
# Server-only configuration. Missing PAIFLOW_MODE defaults to prepare.
# prepare: no wallet actions, payments or event polling.
# Integration and test payments are allowed before the event.
# Select team once your deployment/token are ready, or demo for the shared XLM deployment.
PAIFLOW_MODE=prepare
PAIFLOW_BASE_URL=https://beta.app.paiflow.xyz
PAIFLOW_API_TOKEN=pfk_1b23c705135efa8f84781e548df84a0d411f77735cb02e9fd0583098bb6a907a
PAIFLOW_DEPLOYMENT_ID=97d58263-86bc-4f71-9eab-16fca9defc06

# Optional Webhook helper only; never NEXT_PUBLIC_. Store event key/payload durably.
# PAIFLOW_WEBHOOK_SECRET=

# Emergency Pot: server-only; payment stays disabled pending deployment verification.
PAIFLOW_EMERGENCY_POT_PARENT_DEPLOYMENT_ID=3f61d495-5bfa-4f51-b4e3-f666fc7bf22d
PAIFLOW_EMERGENCY_POT_PARENT_API_TOKEN=
PAIFLOW_EMERGENCY_POT_BROTHER_DEPLOYMENT_ID=d34c35d4-10e0-4b59-9b98-425a1a503023
PAIFLOW_EMERGENCY_POT_BROTHER_API_TOKEN=
PAIFLOW_EMERGENCY_POT_SISTER_DEPLOYMENT_ID=73ebc55f-1a70-4ddd-8172-b05489871c85
PAIFLOW_EMERGENCY_POT_SISTER_API_TOKEN=

````

## vitest.config.ts

````typescript
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  test: { environment: "node", maxWorkers: 4 },
});

````

## components/starter-app.tsx

````tsx
"use client";
import { EmergencyPot } from "@/components/emergency-pot";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PublicConfig } from "@/lib/paiflow";
import type { DeploymentCapabilities, FundingDiscovery, ScheduleState } from "@/lib/api-types";
import { toStroops } from "@/lib/amount";
import { connectWallet, refreshWallet } from "@/lib/wallet";
import { browserRequest } from "@/lib/browser-api";
import { useWalletOperation } from "@/lib/hooks/use-wallet-operation";
import { useActivity } from "@/lib/hooks/use-activity";
import { DeploymentPanels, type Discovery } from "@/components/deployment-panels";

type Page = "home" | "family" | "padala" | "scheduled" | "pot" | "activity";
type MemberId = "jun" | "parents" | "brother" | "sister";
type Member = { id: MemberId; initials: string; name: string; role: string; purpose: string; note: string; color: string };
type Shares = Record<MemberId, number>;
type ScheduledInfo = { capabilities: DeploymentCapabilities | null; funding: FundingDiscovery | null; schedule: ScheduleState | null };

const MEMBERS: Member[] = [
  { id: "jun", initials: "JN", name: "Jun", role: "Breadwinner · Provider", purpose: "Personal reserve", note: "Supporting the family", color: "#f4ba36" },
  { id: "parents", initials: "PR", name: "Parents", role: "Recipient", purpose: "Household needs", note: "For the family at home", color: "#ffffff" },
  { id: "brother", initials: "BR", name: "Brother", role: "Recipient", purpose: "Daily allowance", note: "For everyday needs", color: "#a4dfd0" },
  { id: "sister", initials: "YS", name: "Younger Sister", role: "Recipient", purpose: "School and daily needs", note: "Keep studying", color: "#60baa5" },
];
const DEFAULT_SHARES: Shares = { jun: 30, parents: 40, brother: 15, sister: 15 };
const DEFAULT_ALLOWANCE = "2500";
const STORAGE_KEY = "padala-pabalik-budget-v2";
const SCHEDULED_API = "/api/scheduled/integration";
const SCHEDULED_DEPLOYMENT_ID = "6b6d80a9-c593-4ecb-a965-1a9fc958f627";
const NAVIGATION: { id: Page; label: string; icon: string }[] = [
  { id: "home", label: "Overview", icon: "home" },
  { id: "family", label: "Family Circle", icon: "users" },
  { id: "padala", label: "Send Padala", icon: "send" },
  { id: "scheduled", label: "Scheduled Padala", icon: "calendar" },
  { id: "pot", label: "Emergency Pot", icon: "heart" },
  { id: "activity", label: "Activity", icon: "history" },
];

function money(value: number) {
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} USDC`;
}
type ExchangeRate = { rate: number; date: string; source: string };
function PesoEstimate({ amount, rate, style }: { amount: number; rate: number | null; style?: React.CSSProperties }) {
  return <span style={{ display: "block", fontSize: "0.85em", opacity: 0.83, marginTop: 4, ...style }}>
    {rate === null ? "PHP estimate unavailable" : `≈ ${new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(amount * rate)}`}
  </span>;
}
function decimal(value: string) {
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function allocation(amount: number, percent: number) {
  return Math.round(amount * 100 * percent / 100) / 100;
}
function shortAddress(address: string) {
  return address.length > 18 ? `${address.slice(0, 7)}...${address.slice(-5)}` : address || "Not connected";
}
function dateText(date?: string) {
  if (!date) return "Unavailable";
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleString();
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function unwrap(value: unknown): Record<string, unknown> {
  let result: unknown = value;
  for (let i = 0; i < 2; i++) {
    if (isObject(result) && isObject(result.data) && !("deploymentId" in result)) result = result.data;
  }
  if (!isObject(result)) throw new Error("Scheduled integration returned invalid data.");
  if (result.deploymentId !== SCHEDULED_DEPLOYMENT_ID || result.network !== "testnet") throw new Error("Scheduled deployment ID or network does not match the expected testnet contract.");
  return result;
}
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 21v-8h6v8"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>,
    heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></>,
    wallet: <><rect x="2" y="5" width="20" height="15" rx="3"/><path d="M16 13h6M5 5V3h14"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5M5 9a7 7 0 0 1 12-3l3 1M19 15a7 7 0 0 1-12 3l-3-1"/></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    external: <><path d="M14 3h7v7M10 14 21 3M21 13v7H4V3h7"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.home}</svg>;
}
function Avatar({ initials, large = false }: { initials: string; large?: boolean }) {
  return <span className={`pp-avatar ${large ? "pp-avatar-large" : ""}`}>{initials}</span>;
}
function AllocationBar({ shares }: { shares: Shares }) {
  return <div className="pp-allocation-bar" aria-label="Family budget allocation percentages">{MEMBERS.map(member => <div key={member.id} style={{ width: `${shares[member.id]}%`, background: member.color }} title={`${member.name}: ${shares[member.id]}%`}/>)}</div>;
}
function AllocationCard({ member, shares, allowance, phpRate, onClick }: { member: Member; shares: Shares; allowance: number; phpRate: number | null; onClick?: () => void }) {
  return <div className="pp-allocation-card"><div className="pp-allocation-person"><Avatar initials={member.initials}/><div><strong>{member.name}</strong><p>{member.purpose} · &quot;{member.note}&quot;</p></div></div><div className="pp-allocation-end"><strong>{money(allocation(allowance, shares[member.id]))}</strong><PesoEstimate amount={allocation(allowance, shares[member.id])} rate={phpRate}/><span>{shares[member.id]}%</span>{onClick && <button type="button" className="pp-text-button" onClick={onClick}>View</button>}</div></div>;
}

export function StarterApp({ config, payoutsAvailable: _payoutsAvailable = false }: { config: PublicConfig; payoutsAvailable?: boolean }) {
  const enabled = config.mode === "demo" || config.mode === "team";
  const configIdentity = JSON.stringify(config);
  const [exchangeRate, setExchangeRate] = useState<ExchangeRate | null>(null);
  const [rateError, setRateError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/exchange-rate", { cache: "no-store" });
        if (!response.ok) throw new Error("Exchange rate service unavailable");
        const data: unknown = await response.json();
        if (!isObject(data) || typeof data.rate !== "number" || !Number.isFinite(data.rate) || data.rate <= 0 || typeof data.date !== "string" || typeof data.source !== "string") throw new Error("Invalid exchange rate response");
        if (!cancelled) { setExchangeRate({ rate: data.rate, date: data.date, source: data.source }); setRateError(""); }
      } catch {
        if (!cancelled) { setExchangeRate(null); setRateError("PHP estimate unavailable"); }
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 30 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);
  const [page, setPage] = useState<Page>("home");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("1");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [allowance, setAllowance] = useState(DEFAULT_ALLOWANCE);
  const [shares, setShares] = useState<Shares>(DEFAULT_SHARES);
  const [hydrated, setHydrated] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState<MemberId | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [discoveryError, setDiscoveryError] = useState("");
  const [scheduled, setScheduled] = useState<ScheduledInfo>({ capabilities: null, funding: null, schedule: null });
  const [scheduledLoading, setScheduledLoading] = useState(false);
  const [scheduledError, setScheduledError] = useState("");
  const [walletXlm, setWalletXlm] = useState<string | null>(null);
  const [walletUsdc, setWalletUsdc] = useState<{ balance: string; issuer: string }[]>([]);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState("");
  const [suggestionStatus, setSuggestionStatus] = useState<"pending" | "approved" | "declined">("pending");

  const phpRate = exchangeRate?.rate ?? null;
  const budget = decimal(allowance) ?? 0;
  const paymentAmount = decimal(amount);
  const totalPercentage = MEMBERS.reduce((sum, member) => sum + shares[member.id], 0);
  const validShares = totalPercentage === 100 && MEMBERS.every(member => Number.isFinite(shares[member.id]) && shares[member.id] >= 0 && shares[member.id] <= 100);
  const selectedMember = MEMBERS.find(member => member.id === selectedMemberId) ?? null;
  const scope = discovery ? `${config.mode}:${discovery.platformOrigin}/${discovery.deploymentId}` : "unconfigured";
  const workflow = useWalletOperation(scope, enabled && !!discovery);
  const activity = useActivity(enabled && !!discovery, scope);
  const canPay = enabled && (discovery?.operations.execute.status === "supported" || discovery?.operations.execute.status === "conditional");
  const scheduledNode = scheduled.funding?.nodes.find(node => node.action === "schedule.fund") ?? null;
  const scheduledReady = scheduled.capabilities?.network === "testnet" && scheduled.capabilities.triggerType === "schedule" && scheduledNode !== null && scheduled.schedule !== null;
  const inputAsset = discovery && isObject(discovery) && isObject(discovery.inputAsset) ? discovery.inputAsset : null;
  const assetSymbol = inputAsset?.kind === "known" && typeof inputAsset.symbol === "string" ? inputAsset.symbol : "Unverified asset";
  const inputAssetVerifiedUSDC = assetSymbol === "USDC";
  const pageTitle: Record<Page, string> = { home: "Overview", family: "Family Circle", padala: "Send Padala", scheduled: "Scheduled Padala", pot: "Emergency Pot", activity: "Transaction Activity" };

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const data: unknown = JSON.parse(saved);
        if (isObject(data)) {
          if (typeof data.allowance === "string" && decimal(data.allowance) !== null) setAllowance(data.allowance);
          const savedShares = data.shares;
          if (isObject(savedShares) && MEMBERS.every(member => typeof savedShares[member.id] === "number")) {
            const s = savedShares as unknown as Shares;
            if (MEMBERS.reduce((sum, member) => sum + s[member.id], 0) === 100 && MEMBERS.every(member => Number.isFinite(s[member.id]) && s[member.id] >= 0 && s[member.id] <= 100)) setShares(s);
          }
        }
      }
    } catch { /* Invalid or unavailable browser storage: keep defaults. */ }
    setHydrated(true);
  }, []);
  useEffect(() => { if (hydrated && validShares && decimal(allowance) !== null) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ allowance, shares })); } catch {} } }, [allowance, shares, hydrated, validShares]);

  useEffect(() => {
    if (!enabled) return;
    setAddress("");
    const refresh = () => { void refreshWallet().then(setAddress).catch(() => setAddress("")); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [enabled, configIdentity]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setDiscovery(null);
    setDiscoveryError("");
    void browserRequest<Discovery>("/api/integration?read=capabilities")
      .then(value => { if (!cancelled) setDiscovery(value); })
      .catch(cause => { if (!cancelled) setDiscoveryError(String(cause)); });
    return () => { cancelled = true; };
  }, [enabled, configIdentity]);

  const refreshBalance = useCallback(async (wallet: string) => {
    setWalletXlm(null);
    setWalletUsdc([]);
    setWalletError("");
    if (!/^G[A-Z2-7]{55}$/.test(wallet)) return;
    setWalletLoading(true);
    try {
      const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${encodeURIComponent(wallet)}`, { cache: "no-store" });
      if (response.status === 404) throw new Error("Account not funded on Stellar Testnet.");
      if (!response.ok) throw new Error(`Horizon balance request failed (${response.status}).`);
      const result: unknown = await response.json();
      if (!isObject(result) || !Array.isArray(result.balances)) throw new Error("Invalid account balance response.");
      const native = result.balances.find((balance: unknown) => isObject(balance) && balance.asset_type === "native");
      setWalletXlm(isObject(native) && typeof native.balance === "string" ? native.balance : "0");
      // Horizon exposes issued-asset trustlines. The asset code alone does not
      // establish that a token is Circle USDC: always identify its issuer.
      const usdcTrustlines = result.balances
        .filter((balance: unknown) => isObject(balance) && balance.asset_code === "USDC" && typeof balance.asset_issuer === "string" && typeof balance.balance === "string")
        .map((balance: unknown) => {
          const item = balance as Record<string, unknown>;
          return { balance: String(item.balance), issuer: String(item.asset_issuer) };
        });
      setWalletUsdc(usdcTrustlines);
    } catch (cause) { setWalletError(cause instanceof Error ? cause.message : "Unable to fetch wallet balance."); }
    finally { setWalletLoading(false); }
  }, []);
  useEffect(() => { void refreshBalance(address); }, [address, refreshBalance]);

  const loadScheduled = useCallback(async () => {
    if (!enabled) return;
    setScheduledLoading(true);
    setScheduledError("");
    try {
      const [rawCapabilities, rawFunding] = await Promise.all([
        browserRequest<unknown>(`${SCHEDULED_API}?read=capabilities`),
        browserRequest<unknown>(`${SCHEDULED_API}?read=funding`),
      ]);
      const caps = unwrap(rawCapabilities);
      const funds = unwrap(rawFunding);
      if (caps.triggerType !== "schedule" || !isObject(caps.operations)) throw new Error("Scheduled capabilities are invalid.");
      if (!Array.isArray(funds.nodes)) throw new Error("Scheduled funding nodes are missing.");
      const funding = funds as unknown as FundingDiscovery;
      const node = funding.nodes.find(item => item.action === "schedule.fund");
      if (!node) throw new Error("No schedule.fund node was found.");
      const state = unwrap(await browserRequest<unknown>(`${SCHEDULED_API}?read=schedule&nodeId=${encodeURIComponent(node.nodeId)}`));
      if (state.nodeId !== node.nodeId || typeof state.paused !== "boolean" || typeof state.balanceStroops !== "string" || typeof state.availableStroops !== "string") throw new Error("Scheduled contract state is invalid.");
      setScheduled({ capabilities: caps as unknown as DeploymentCapabilities, funding, schedule: state as unknown as ScheduleState });
    } catch (cause) {
      setScheduled({ capabilities: null, funding: null, schedule: null });
      setScheduledError(cause instanceof Error ? cause.message : "Could not load schedule.");
    } finally { setScheduledLoading(false); }
  }, [enabled]);
  useEffect(() => { void loadScheduled(); }, [loadScheduled, configIdentity]);

  async function connect() {
    try { setAddress(await connectWallet()); setError(""); } catch (cause) { setError(String(cause)); }
  }
  async function refreshConnectedWallet() {
    try { const wallet = await refreshWallet(); setAddress(wallet); await refreshBalance(wallet); setError(""); } catch (cause) { setError(String(cause)); }
  }
  function navigate(next: Page) { setPage(next); setMobileMenuOpen(false); setNotice(""); }
  function changeShare(id: MemberId, value: string) {
    if (value === "") { setShares(prev => ({ ...prev, [id]: 0 })); return; }
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0 && number <= 100) setShares(prev => ({ ...prev, [id]: number }));
  }



  return <div className="pp-app">
    <aside className={`pp-sidebar ${mobileMenuOpen ? "pp-sidebar-open" : ""}`}>
      <div className="pp-brand"><div className="pp-brand-icon"><Icon name="home" size={25}/><span>♥</span></div><div><div className="pp-brand-name">Padala <span>Pabalik</span></div><p>Padala na may malasakit</p></div></div>
      <div className="pp-sidebar-label">YOUR WORKSPACE</div>
      <nav className="pp-navigation">{NAVIGATION.map(item => <button key={item.id} type="button" className={`pp-nav-item ${page === item.id ? "pp-nav-active" : ""}`} onClick={() => navigate(item.id)}><Icon name={item.icon}/><span>{item.label}</span></button>)}</nav>
      <div className="pp-sidebar-bottom"><div className="pp-sidebar-help"><Icon name="shield" size={23}/><div><strong>Powered by Stellar</strong><p>Transparent family support through Paiflow.</p></div></div><div className="pp-sidebar-profile"><Avatar initials="JN"/><div><strong>Jun</strong><p>Breadwinner · Provider</p></div></div></div>
    </aside>
    {mobileMenuOpen && <button type="button" className="pp-mobile-overlay" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)}/>}
    <div className="pp-content">
      <header className="pp-topbar"><div className="pp-topbar-left"><button type="button" className="pp-mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileMenuOpen(true)}><Icon name="menu"/></button><div className="pp-breadcrumb"><span>Workspace</span><span>/</span><strong>{pageTitle[page]}</strong></div></div><div className="pp-topbar-right"><span className="pp-network-badge" data-testid="network-chip"><span className="pp-status-dot"/>Stellar Testnet</span><button type="button" className="pp-wallet-button" disabled={!enabled || workflow.busy} onClick={() => void connect()} title={address || "Connect Freighter"}><Icon name="wallet" size={18}/>{address ? shortAddress(address) : "Connect Wallet"}</button></div></header>
      <main className="pp-main">
        {config.mode === "prepare" && <div className="pp-notice">Preparation mode: wallet actions are unavailable.</div>}
        {config.mode === "disabled" && <div className="pp-notice pp-notice-error" role="alert">Payments unavailable: {config.message}</div>}
        {config.mode === "demo" && <div className="pp-notice">Demo mode uses a shared testnet deployment. Use a test wallet.</div>}
        {error && <div className="pp-notice pp-notice-error" role="alert">{error}</div>}
        {notice && <div className="pp-notice" role="status">{notice}</div>}
        {exchangeRate && <p className="pp-muted" style={{ fontSize: 12, margin: "4px 0 12px" }}>Estimated conversion: 1 USDC ≈ ₱{exchangeRate.rate.toFixed(4)} (USD/PHP reference rate from {exchangeRate.source}, dated {exchangeRate.date}). Not a guaranteed cash-out quote.</p>}
        {rateError && <p className="pp-muted" style={{ fontSize: 12 }}>{rateError}</p>}

        {page === "home" && <>
          <div className="pp-page-heading"><div><div className="pp-eyebrow">WELCOME BACK, JUN</div><h1>Your family, <span>taken care of.</span></h1><p>Plan your support and keep everyone in the loop.</p></div><button type="button" className="pp-primary-button" onClick={() => navigate("padala")}><Icon name="send" size={17}/>Send Padala</button></div>
          <div className="pp-dashboard-grid"><div className="pp-dashboard-main">
            <div className="pp-hero-card"><div className="pp-hero-top"><span>MONTHLY FAMILY BUDGET</span><span className="pp-hero-tag">Editable plan</span></div><div className="pp-hero-amount">{money(budget)}</div><PesoEstimate amount={budget} rate={phpRate} style={{ color: "#c4f5e4", fontSize: 22, fontWeight: 700, marginBottom: 10 }}/><p>Planned monthly support. Edit the budget or allocations below.</p><AllocationBar shares={shares}/><div className="pp-hero-footer"><span>4 family members</span><span>{totalPercentage}% assigned</span></div><button type="button" className="pp-secondary-button" style={{ marginTop: 16 }} onClick={() => navigate("family")}>Edit monthly budget <Icon name="arrow" size={16}/></button></div>
            <div className="pp-section-heading"><div><h2>Family allocations</h2><p>Jun 30% · Parents 40% · Brother 15% · Younger Sister 15% by default.</p></div><button type="button" className="pp-link-button" onClick={() => navigate("family")}>Edit allocations <Icon name="arrow" size={16}/></button></div>
            <div className="pp-allocation-list">{MEMBERS.map(member => <AllocationCard key={member.id} member={member} shares={shares} allowance={budget} phpRate={phpRate} onClick={() => { setSelectedMemberId(member.id); navigate("family"); }}/>)}</div>
          </div><div className="pp-dashboard-side">
            <div className="pp-side-card"><div className="pp-card-icon"><Icon name="calendar"/></div><div className="pp-small-label">SCHEDULED PADALA</div><h3>{scheduled.schedule ? scheduled.schedule.paused ? "Schedule paused" : "Schedule running" : "Check your schedule"}</h3><p>{scheduled.schedule ? "Your scheduled contract is connected to Paiflow." : "Monitor your scheduled distribution."}</p><button type="button" className="pp-secondary-button" onClick={() => navigate("scheduled")}>View schedule <Icon name="arrow" size={16}/></button></div>
            <div className="pp-request-card"><div className="pp-request-icon"><Icon name="bell"/></div><div className="pp-small-label">EMERGENCY REQUESTS</div><h3>Family emergency requests</h3><p>Review recipient-specific requests and local demo approvals.</p><button type="button" className="pp-secondary-button" onClick={() => navigate("pot")}>Open Emergency Pot <Icon name="arrow" size={16}/></button></div>
            <div className="pp-side-card"><div className="pp-small-label">WALLET STATUS</div><h3>{address ? "Wallet connected" : "Connect Freighter"}</h3><p className="pp-address">{shortAddress(address)}</p><div className="pp-wallet-balance">
              <span className="pp-small-label">STELLAR TESTNET BALANCES</span>
              <div className="pp-preview-row"><span>XLM</span><strong>{walletLoading ? "Loading..." : walletXlm !== null ? `${Number(walletXlm).toLocaleString("en-US", { maximumFractionDigits: 7 })} XLM` : "—"}</strong></div>
              <div className="pp-preview-row"><span>USDC</span><strong>{walletLoading ? "Loading..." : walletXlm === null ? "—" : walletUsdc.length === 0 ? "0.00 USDC" : walletUsdc.length === 1 ? `${Number(walletUsdc[0]?.balance ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 7 })} USDC` : `${walletUsdc.length} trustlines`}</strong></div>
              {walletUsdc.map(token => <div key={token.issuer} className="pp-preview-row"><span className="pp-muted" title={token.issuer}>Issuer: {shortAddress(token.issuer)}</span><strong>{walletUsdc.length > 1 ? `${Number(token.balance).toLocaleString("en-US", { maximumFractionDigits: 7 })} USDC` : ""}</strong></div>)}
              <span className="pp-muted">USDC balances are reported from Stellar Testnet trustlines. Verify the issuer before treating a token as genuine USDC. Soroban-only token balances may not appear here.</span>
            </div>{walletError && <p className="pp-muted">{walletError}</p>}<div className="pp-button-row"><button type="button" className="pp-secondary-button" disabled={!enabled || workflow.busy} onClick={() => void connect()}><Icon name="wallet" size={16}/>{address ? "Reconnect" : "Connect"}</button><button type="button" className="pp-icon-button" aria-label="Refresh wallet balance" disabled={!enabled || workflow.busy || walletLoading} onClick={() => void refreshConnectedWallet()}><Icon name="refresh" size={17}/></button></div></div>
          </div></div>
        </>}

        {page === "family" && <>
          <div className="pp-page-heading"><div><div className="pp-eyebrow">PEOPLE WHO MATTER</div><h1>Your <span>family circle.</span></h1><p>Four members, one editable monthly support plan.</p></div></div>
          <div className="pp-family-grid"><div className="pp-family-main">
            <div className="pp-section-heading"><div><h2>Monthly allowance</h2><p>Changes are saved in this browser.</p></div></div>
            <label className="pp-form-label">Monthly family budget (USDC)<div className="pp-amount-field"><input type="text" inputMode="decimal" value={allowance} onChange={event => setAllowance(event.target.value)} placeholder="2500.00"/><span>USDC</span></div></label><PesoEstimate amount={budget} rate={phpRate}/>
            {decimal(allowance) === null && <p className="pp-allocation-error">Enter a valid nonnegative amount with at most two decimal places.</p>}
            <div className="pp-section-heading"><div><h2>Edit allocation percentages</h2><p>All four percentages must add up to exactly 100%.</p></div><button type="button" className="pp-text-button" onClick={() => setShares(DEFAULT_SHARES)}>Reset to defaults</button></div>
            <div className="pp-allocation-editor-list">{MEMBERS.map(member => <div className="pp-allocation-editor-row" key={member.id}><div className="pp-allocation-person"><Avatar initials={member.initials}/><div><strong>{member.name}</strong><p>{money(allocation(budget, shares[member.id]))}</p><PesoEstimate amount={allocation(budget, shares[member.id])} rate={phpRate}/></div></div><label className="pp-percentage-input"><input type="number" min="0" max="100" step="1" aria-label={`${member.name} percentage`} value={shares[member.id]} onChange={event => changeShare(member.id, event.target.value)}/><span>%</span></label></div>)}</div>
            <div className="pp-allocation-total"><strong>Total allocated</strong><strong>{totalPercentage}% / 100%</strong></div>
            {!validShares && <p className="pp-allocation-error">Allocations must total exactly 100%. The current draft will not be saved until valid.</p>}
            <AllocationBar shares={shares}/><p className="pp-muted">This is your planning budget only. Editing percentages does not change the recipient wallets or split in the deployed Paiflow workflow.</p>
            <div className="pp-section-heading"><div><h2>Family members</h2><p>Only four members are included in the budget.</p></div></div>
            <div className="pp-family-list">{MEMBERS.map(member => <button type="button" key={member.id} className="pp-family-row pp-family-row-button" onClick={() => setSelectedMemberId(member.id)}><Avatar initials={member.initials}/><div className="pp-family-details"><strong>{member.name}</strong><p>{member.role}</p></div><Icon name="arrow" size={17}/></button>)}</div>
          </div><div className="pp-family-side"><div className="pp-side-card"><div className="pp-card-icon"><Icon name="heart"/></div><h3>Every share has a purpose.</h3><p>Jun, Parents, Brother and Younger Sister are the four members of this plan.</p><AllocationBar shares={shares}/></div><div className="pp-side-card">{selectedMember ? <><div className="pp-family-selected"><Avatar initials={selectedMember.initials} large/><h3>{selectedMember.name}</h3><p>{selectedMember.role}</p></div><div className="pp-member-amount">{money(allocation(budget, shares[selectedMember.id]))}</div><PesoEstimate amount={allocation(budget, shares[selectedMember.id])} rate={phpRate} style={{ color: "#187858", fontSize: 19, fontWeight: 700, marginBottom: 12 }}/><div className="pp-note">{selectedMember.purpose} · &quot;{selectedMember.note}&quot;</div><p className="pp-muted">{shares[selectedMember.id]}% of the planned monthly budget.</p></> : <><h3>Get to know your circle</h3><p>Select a family member to view their share.</p></>}</div></div></div>
        </>}

        {page === "padala" && <>
          <div className="pp-page-heading"><div><div className="pp-eyebrow">INSTANT TRANSFER</div><h1>Send with <span>malasakit.</span></h1><p>Review the amount and your family budget preview before signing.</p></div><span className="pp-soft-badge">On Receive → Split</span></div>
          <div className="pp-payment-grid"><div className="pp-payment-main"><div className="pp-white-card"><div className="pp-section-heading"><div><h2>Instant Padala</h2><p>Powered by Paiflow on Stellar Testnet.</p></div><div className="pp-card-icon"><Icon name="send"/></div></div>
            {discoveryError && <div className="pp-notice pp-notice-error" role="alert">{discoveryError}</div>}
            {enabled && !canPay && <div className="pp-notice">{discovery ? "This deployment does not support instant execution." : "Checking payment capabilities..."}</div>}
            <form onSubmit={event => { event.preventDefault(); try { setError(""); if (!validShares) throw new Error("Your budget allocations must total 100% before continuing."); if (paymentAmount === null || paymentAmount <= 0) throw new Error("Enter a positive payment amount."); void workflow.start("execute", address, { from: address, amount: toStroops(amount) }); } catch (cause) { setError(String(cause)); } }}>
              <label className="pp-form-label">Amount to send<div className="pp-amount-field"><input required type="text" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00"/><span>{inputAssetVerifiedUSDC ? "USDC" : assetSymbol}</span></div></label>{inputAssetVerifiedUSDC && <PesoEstimate amount={paymentAmount ?? 0} rate={phpRate}/>}
              <div className="pp-payment-info"><Icon name="shield" size={20}/><p>Freighter will ask you to review and sign the transaction. The actual token and recipients are defined by your Paiflow deployment, not this preview. Confirm the asset in Freighter before signing.</p></div>
              {!inputAssetVerifiedUSDC && <div className="pp-notice">The instant deployment has not been verified as USDC. The budget preview uses USDC, but the on-chain transaction may use another asset. Check the asset and amount in Freighter.</div>}
              <button type="submit" className="pp-primary-button pp-wide-button" disabled={!canPay || workflow.blocked || !address || !validShares || paymentAmount === null || paymentAmount <= 0}><Icon name="send" size={18}/>{workflow.busy ? "Processing transaction..." : "Review Instant Padala"}</button>
            </form>{workflow.message && <div className="pp-notice" role="status">{workflow.message}</div>}
          </div>
          {workflow.recovery && <div className="pp-white-card"><h2>Recover Existing Transaction</h2><p>Operation: {workflow.recovery.operation}</p><p className="pp-address">{workflow.recovery.prepared.txHash ?? "Transaction hash unavailable"}</p><p>Do not start another payment while this one is unresolved.</p><button type="button" className="pp-secondary-button" disabled={!enabled || workflow.busy} onClick={() => void workflow.reconcile()}>Check Transaction Again</button></div>}
          {discovery && <div className="pp-integration-panel"><DeploymentPanels capabilities={discovery} address={address} blocked={workflow.blocked} start={workflow.start}/></div>}
          </div><div className="pp-payment-side"><div className="pp-side-card"><div className="pp-small-label">FAMILY BUDGET PREVIEW</div><h3>Where your padala goes</h3><p>Preview of {money(paymentAmount ?? 0)} at your editable budget percentages. Not a confirmation of the deployed on-chain split.</p><PesoEstimate amount={paymentAmount ?? 0} rate={phpRate}/><AllocationBar shares={shares}/>{MEMBERS.map(member => <div className="pp-preview-row" key={member.id}><span>{member.name} ({shares[member.id]}%)</span><div><strong>{money(allocation(paymentAmount ?? 0, shares[member.id]))}</strong><PesoEstimate amount={allocation(paymentAmount ?? 0, shares[member.id])} rate={phpRate}/></div></div>)}{!validShares && <p className="pp-allocation-error">Percentages currently total {totalPercentage}%, not 100%.</p>}</div><div className="pp-side-card"><div className="pp-card-icon"><Icon name="shield"/></div><h3>Transparent by design</h3><p>Actual payment recipients and split percentages are controlled by the deployed Paiflow workflow.</p><p className="pp-muted">Changing the budget preview does not reconfigure the blockchain deployment.</p></div></div></div>
        </>}

        {page === "scheduled" && <>
          <div className="pp-page-heading"><div><div className="pp-eyebrow">FUTURE DISTRIBUTIONS</div><h1>Plan ahead, <span>send with care.</span></h1><p>Monitor your deployed Scheduled Padala contract on Stellar Testnet.</p></div><button type="button" className="pp-secondary-button" disabled={!enabled || scheduledLoading} onClick={() => void loadScheduled()}><Icon name="refresh" size={17}/>{scheduledLoading ? "Refreshing..." : "Refresh Schedule"}</button></div>
          {scheduledError && <div className="pp-notice pp-notice-error" role="alert">{scheduledError}</div>}
          {!scheduledReady && !scheduledError && <div className="pp-notice">{scheduledLoading ? "Loading scheduled contract..." : "Schedule information unavailable."}</div>}
          <div className="pp-stats-grid"><div className="pp-stat-card"><div className="pp-small-label">SCHEDULE STATUS</div><h3>{scheduled.schedule ? scheduled.schedule.paused ? "Paused" : "Running" : "Unavailable"}</h3><p>{scheduled.schedule ? "Live contract state" : "Waiting for contract data"}</p></div><div className="pp-stat-card"><div className="pp-small-label">CONTRACT BALANCE</div><h3>{scheduled.schedule?.balanceStroops ?? "—"}</h3><p>Raw token units</p></div><div className="pp-stat-card"><div className="pp-small-label">AVAILABLE TO CLAIM</div><h3>{scheduled.schedule?.availableStroops ?? "—"}</h3><p>Raw token units</p></div></div>
          <div className="pp-payment-grid"><div className="pp-payment-main"><div className="pp-white-card"><div className="pp-section-heading"><div><h2>Scheduled funding</h2><p>Prefund the schedule contract for future distributions.</p></div><div className="pp-card-icon"><Icon name="calendar"/></div></div>{scheduled.capabilities && <div className="pp-detail-list"><div><span>Network</span><strong>{scheduled.capabilities.network}</strong></div><div><span>Trigger</span><strong>{scheduled.capabilities.triggerType}</strong></div><div><span>Asset</span><strong>{scheduled.capabilities.inputAsset?.kind === "known" ? scheduled.capabilities.inputAsset.symbol : "Unknown"}</strong></div><div><span>Funding support</span><strong>{scheduled.capabilities.operations?.funding?.status ?? "Unknown"}</strong></div></div>}<button type="button" className="pp-primary-button pp-wide-button" disabled>Fund Scheduled Padala (Verification Pending)</button><p className="pp-muted">Funding is disabled until token precision and wallet authorization are verified.</p><div className="pp-payment-info"><Icon name="shield" size={20}/><p>Funding adds tokens to the schedule contract. It does not immediately pay recipients.</p></div></div>{scheduled.schedule && <div className="pp-white-card"><h2>Live contract information</h2><div className="pp-detail-list"><div><span>Claimed</span><strong>{scheduled.schedule.claimedStroops}</strong></div><div><span>Paused</span><strong>{scheduled.schedule.paused ? "Yes" : "No"}</strong></div><div><span>Last updated</span><strong>{dateText(scheduled.schedule.readAt)}</strong></div></div><p className="pp-small-label">CONTROLLER</p><p className="pp-address">{scheduled.schedule.controller}</p></div>}</div><div className="pp-payment-side"><div className="pp-side-card"><div className="pp-small-label">PAIFLOW DEPLOYMENT</div><h3>On Schedule → Split</h3><p className="pp-address">{SCHEDULED_DEPLOYMENT_ID}</p>{scheduledNode && <><div className="pp-detail-list"><div><span>Node</span><strong>{scheduledNode.nodeId}</strong></div><div><span>Action</span><strong>{scheduledNode.action}</strong></div></div><p className="pp-small-label">CONTRACT ADDRESS</p><p className="pp-address">{scheduledNode.contractAddress}</p><p className="pp-small-label">TOKEN CONTRACT</p><p className="pp-address">{scheduledNode.tokenContractAddress}</p></>}</div><div className="pp-request-card"><div className="pp-small-label">IMPORTANT</div><h3>Scheduled does not mean paid</h3><p>Verify actual on-chain payouts separately.</p></div></div></div>
        </>}

        {page === "pot" && <EmergencyPot phpRate={phpRate}/>}

        {page === "activity" && <><div className="pp-page-heading"><div><div className="pp-eyebrow">TRANSPARENCY</div><h1>Your padala, <span>on record.</span></h1><p>Review events reported by your Paiflow deployment.</p></div></div><div className="pp-white-card"><div className="pp-section-heading"><div><h2>Blockchain activity</h2><p>Events may appear after a short delay.</p></div><div className="pp-card-icon"><Icon name="history"/></div></div>{activity.error && <div className="pp-notice pp-notice-error" role="alert">{activity.error}</div>}{activity.events.length === 0 && <div className="pp-empty-state"><Icon name="history" size={32}/><h3>No events to display yet</h3><p>Paiflow deployment events will appear here when available.</p></div>}<div className="pp-activity-list">{activity.events.map(event => <div key={event.eventId} className="pp-activity-item"><div className="pp-activity-icon"><Icon name="check"/></div><div className="pp-activity-details"><strong>{event.kind}</strong>{event.topic && <p>{event.topic}</p>}<span>{dateText(event.occurredAt)}</span><details><summary>Event details</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details></div>{event.txHash && <a className="pp-link-button" href={`https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(event.txHash)}`} target="_blank" rel="noreferrer">View transaction <Icon name="external" size={16}/></a>}</div>)}</div></div></>}
        <footer className="pp-footer"><span>Padala Pabalik · Padala na may malasakit</span><span>Stellar Testnet · Powered by Paiflow</span></footer>
      </main>
    </div>
  </div>;
}

````

## components/emergency-pot.tsx

````tsx
"use client";
import { EmergencyPaymentPanel } from "@/components/emergency-payment";
import { useEffect, useRef, useState } from "react";
import { signMessage, getNetworkDetails } from "@stellar/freighter-api";
import { connectWallet, refreshWallet } from "@/lib/wallet";
import { browserRequest } from "@/lib/browser-api";
import { createRequest, decisionMessage, readRequests, EMERGENCY_NAMES, EMERGENCY_RECIPIENTS, type EmergencyRequest, type EmergencyRecipient, type EmergencyIntegration } from "@/lib/emergency";

const KEY = "padala-pabalik-emergency-v3";
export function EmergencyPot({ phpRate }: { phpRate: number | null }) {
  const [requests, setRequests] = useState<EmergencyRequest[]>([]);
  const [recipient, setRecipient] = useState<EmergencyRecipient>("parents");
  const [reviewing, setReviewing] = useState(false);
  const reviewLock = useRef(false);
  const [amount, setAmount] = useState("50");
  const [reason, setReason] = useState("");
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [integrations, setIntegrations] = useState<EmergencyIntegration[]>([]);

  const [confirmation, setConfirmation] = useState<string | null>(null);
  useEffect(() => {
    let hasSaved = false;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        hasSaved = true;
        const records = readRequests(raw);
        const previous: EmergencyRequest[] = JSON.parse(raw);
        if (previous.some(record => !record.decision && (record.status !== "pending" || record.approvals.length))) setMessage("Previous simulated decisions were reset. These requests now need one active-wallet signature.");
        setRequests(records.map(record => ({ ...record, approvals: [], status: "pending", decision: undefined })));
        setReady(false);
        void Promise.all(records.map(record => record.decision ? browserRequest<EmergencyRequest>("/api/emergency/approval", { request: record, verify: true }) : Promise.resolve(record))).then(setRequests).catch(() => { setBlocked(true); setMessage("Saved wallet approvals could not be verified. Updates blocked; preserve history and try reloading."); }).finally(() => setReady(true));
      }
      else if (localStorage.getItem("padala-pabalik-emergency-v2")) setMessage("Previous demo requests remain in v2 storage. They lack requester and distinct approval evidence; recreate them here for review.");
    } catch { setBlocked(true); setMessage("Emergency history could not be read. New changes are blocked to preserve existing records."); }
    if (!hasSaved) setReady(true);
    let cancelled = false;
    browserRequest<EmergencyIntegration[]>("/api/emergency/integration").then(data => { if (!cancelled) setIntegrations(data); }).catch(() => { if (!cancelled) setMessage("Emergency configuration unavailable. Refresh to retry live payment verification."); });
    return () => { cancelled = true; };
  }, []);
  async function review(request: EmergencyRequest, approve: boolean) {
    if (reviewLock.current || blocked || !ready) return;
    reviewLock.current = true; setReviewing(true); setMessage("");
    try {
      if (!navigator.locks) throw new Error("Use a browser with Web Locks for wallet approvals.");
      await navigator.locks.request(KEY, async () => {
        const current = readRequests(localStorage.getItem(KEY) ?? "[]");
        const record = current.find(item => item.id === request.id);
        if (!record || record.status !== "pending") throw new Error("This request has already been reviewed or is unavailable.");
        const address = await connectWallet();
        const network = await getNetworkDetails();
        if (network.error || network.networkPassphrase !== "Test SDF Network ; September 2015") throw new Error("Switch Freighter to Testnet to review requests.");
        const signed = await signMessage(decisionMessage(record, approve, window.location.origin), { address, networkPassphrase: network.networkPassphrase });
        if (signed.error) throw new Error(signed.error.message);
        if (!signed.signedMessage || signed.signerAddress !== address || await refreshWallet() !== address) throw new Error("Active wallet changed or did not provide its signature.");
        const signature = typeof signed.signedMessage === "string" ? signed.signedMessage : signed.signedMessage.toString("base64");
        const decided = await browserRequest<EmergencyRequest>("/api/emergency/approval", { request: record, signerAddress: address, signature, approve });
        localStorage.setItem(KEY, JSON.stringify(current.map(item => item.id === record.id ? decided : item)));
        setRequests(current.map(item => item.id === record.id ? decided : item));
        setMessage(approve ? "Approved by the active wallet. No payment sent." : "Rejected by the active wallet. No payment sent.");
      });
    } catch (error) { setMessage(error instanceof Error ? error.message : "Wallet review failed; no decision saved."); }
    finally { reviewLock.current = false; setReviewing(false); }
  }
  function commit(update: (current: EmergencyRequest[]) => EmergencyRequest[]) {
    if (!ready || blocked) return;
    try {
      // Re-read inside a cross-tab lock; never overwrite a concurrent approval.
      if (!navigator.locks) throw new Error("Use a browser with Web Locks to safely update demo history.");
      void navigator.locks.request(KEY, async () => {
        try {
          const raw = localStorage.getItem(KEY);
          const next = update(raw ? readRequests(raw) : []);
          localStorage.setItem(KEY, JSON.stringify(next));
          setRequests(next); setMessage("");
        } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save demo history."); }
      }).catch(() => setMessage("Unable to lock demo history."));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save demo history."); }
  }
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key !== KEY) return;
      try {
        const records = event.newValue ? readRequests(event.newValue) : [];
        setReady(false);
        setRequests(records.map(record => ({ ...record, approvals: [], status: "pending", decision: undefined })));
        void Promise.all(records.map(record => record.decision ? browserRequest<EmergencyRequest>("/api/emergency/approval", { request: record, verify: true }) : Promise.resolve(record))).then(setRequests).catch(() => { setBlocked(true); setMessage("Changed wallet approvals could not be verified; updates blocked."); }).finally(() => setReady(true));
      } catch { setBlocked(true); setMessage("Emergency history changed to an invalid record; updates blocked."); }
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return <>
    <div className="pp-page-heading"><div><div className="pp-eyebrow">FAMILY SAFETY NET</div><h1>Emergency <span>support for your family.</span></h1><p>Recipient-specific requests, separate from Instant Padala.</p></div><span className="pp-soft-badge">Wallet approvals - Testnet</span></div>
    {message && <div className="pp-notice" role="status">{message}</div>}
    <div className="pp-payment-grid"><div className="pp-payment-main">
      <div className="pp-white-card"><h2>New emergency request</h2><p>Saved in this browser only. One approval from the active Freighter wallet is required. Signing an approval message does not send funds.</p>
        <form onSubmit={event => { event.preventDefault(); try { const request = createRequest(recipient, amount, reason); commit(current => [request, ...current]); setReason(""); } catch (error) { setMessage(error instanceof Error ? error.message : "Invalid request."); } }}>
          <label className="pp-form-label">Requester <select value={recipient} onChange={event => setRecipient(event.target.value as EmergencyRecipient)}>{EMERGENCY_RECIPIENTS.map(id => <option key={id} value={id}>{EMERGENCY_NAMES[id]}</option>)}</select></label>
          <label className="pp-form-label">Amount (0?10,000 USDC, positive only)<div className="pp-amount-field"><input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} required/><span>USDC</span></div></label>
          <label className="pp-form-label">Reason<div className="pp-amount-field"><input value={reason} onChange={event => setReason(event.target.value)} maxLength={180} required/></div></label>
          <button disabled={!ready || blocked} className="pp-primary-button" type="submit">Submit emergency request</button>
        </form>
      </div>
      <div className="pp-white-card"><h2>Emergency requests</h2><p>Approve or reject using your active Freighter wallet.</p>
        {!requests.length && <p>No requests yet.</p>}
        {requests.map(request => <div key={request.id} style={{ padding: "16px 0", borderBottom: "1px solid #e2ebe6" }}>
          <div className="pp-preview-row"><strong>{EMERGENCY_NAMES[request.requester]}</strong><strong>{request.amount} USDC</strong></div>
          <p>{request.reason}</p><p className="pp-muted">{new Date(request.createdAt).toLocaleString()} ? {request.status === "rejected" ? "Rejected" : request.status === "approved" ? "Approved - see payment status below" : "Pending"}</p>
          <p>{phpRate === null ? "PHP estimate unavailable" : `Estimated PHP ${new Intl.NumberFormat("en-PH", { maximumFractionDigits: 2 }).format(Number(request.amount) * phpRate)}`}</p>
          <div className="pp-approval-progress"><div style={{ width: `${request.approvals.length * 100}%` }}/></div><p>{request.approvals.length} of 1 wallet approval{request.approvals.length > 0 ? ` ? ${request.approvals.map(id => `${id.slice(0, 7)}...${id.slice(-5)}`).join(", ")}` : ""}</p>
          {request.status === "pending" && <div className="pp-button-row">{[true, false].map(approve => <button key={String(approve)} type="button" className="pp-outline-button" disabled={!ready || blocked || reviewing} onClick={() => void review(request, approve)}>{reviewing ? "Waiting for wallet..." : approve ? "Approve with active wallet" : "Reject with active wallet"}</button>)}</div>}
          {request.status === "approved" && <EmergencyPaymentPanel request={request} integration={integrations.find(item => item.recipient === request.requester)} expanded={confirmation === request.id} onReview={() => setConfirmation(request.id)} onClose={() => setConfirmation(null)}/>}
          <small>Request ID: {request.id}</small>
        </div>)}
      </div>

    </div><div className="pp-payment-side"><div className="pp-side-card"><h3>Payment safety</h3><p>Each requester has a separate Emergency Pot deployment. Emergency payments never open Instant Padala or its family split.</p><p>Approval requires a verified signature from the active wallet. Requests are still stored locally, not in a shared authenticated backend. There is no shared emergency balance connected.</p><p>Request history stays in this browser; payment attempts are durably retained by the local server. Paid requires verified on-chain transfers. Unknown outcomes never start a replacement payment.</p></div></div></div>
  </>;
}

````

## components/emergency-payment.tsx

````tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { browserRequest } from "@/lib/browser-api";
import { connectWallet, signPrepared } from "@/lib/wallet";
import { EMERGENCY_NAMES, type EmergencyIntegration, type EmergencyPayment, type EmergencyRequest } from "@/lib/emergency";

const ENDPOINT = "/api/emergency/integration";
export function EmergencyPaymentPanel({ request, integration, expanded, onReview, onClose }: { request: EmergencyRequest; integration?: EmergencyIntegration; expanded: boolean; onReview: () => void; onClose: () => void }) {
  const [payment, setPayment] = useState<EmergencyPayment | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const storageBlocked = useRef(false);
  const key = `padala-pabalik:emergency-payment:v1:${request.id}`;
  const evidence = JSON.stringify(request);
  function writeLocal(storageKey: string, value: string) {
    try { localStorage.setItem(storageKey, value); }
    catch { storageBlocked.current = true; throw new Error("Recovery storage unavailable. Payment stopped before any further signing or submission; retain the original server attempt."); }
  }
  function remember(value: EmergencyPayment) {
    writeLocal(key, JSON.stringify(value));
    setPayment(value);
  }
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoaded(false);
    async function check() {
      try {
        if (lock.current) { timer = setTimeout(check, 5000); return; }
        const value = await browserRequest<EmergencyPayment | null>(ENDPOINT, { phase: "status", request: JSON.parse(evidence) });
        if (cancelled) return;
        if (value) {
          // Preserve a locally signed envelope when submit never reached the server.
          const saved = localStorage.getItem(key);
          const local: EmergencyPayment | null = saved ? JSON.parse(saved) : null;
          const next = value.prepared && local?.txHash === value.txHash && local?.signedXdr && !value.signedXdr ? { ...value, signedXdr: local.signedXdr } : value;
          remember(next);
          setMessage(next.message);
          if (next.state === "reserved") timer = setTimeout(check, 30000);
        } else {
          if (localStorage.getItem(key)) {
            storageBlocked.current = true;
            setMessage("Local payment evidence exists but the durable server record is missing. Restore the server record before continuing; do not start a replacement.");
          } else { setPayment(null); }
        }
        setLoaded(true);
      } catch (error) {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : "Original payment status unavailable. Check again.");
        timer = setTimeout(check, 15000);
      }
    }
    void check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [evidence, key]);
  async function send() {
    if (lock.current || !loaded || storageBlocked.current) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      if (!navigator.locks) throw new Error("Use a browser with Web Locks to serialize emergency payments.");
      await navigator.locks.request(key, async () => {
        const address = await connectWallet();
        if (address !== request.decision?.signerAddress) throw new Error("Switch Freighter to the wallet that approved this request before authorizing its payment.");
        // Recheck server state inside the tab lock. An existing attempt always wins.
        let current = await browserRequest<EmergencyPayment | null>(ENDPOINT, { phase: "status", request });
        if (!current && localStorage.getItem(key)) throw new Error("Local transaction evidence exists but the server record is missing. Restore it before continuing.");
        if (!current || current.state === "refused") {
          // Record that a prepare request may reach the server before making it.
          writeLocal(`${key}:preparing`, JSON.stringify({ requestId: request.id, deploymentId: integration?.deploymentId, payer: address }));
          current = await browserRequest<EmergencyPayment>(ENDPOINT, { phase: "prepare", request });
        }
        if (!current) throw new Error("Original payment preparation unavailable.");
        const saved = localStorage.getItem(key);
        const local: EmergencyPayment | null = saved ? JSON.parse(saved) : null;
        if (local?.txHash === current.txHash && local?.signedXdr && !current.signedXdr) current = { ...current, signedXdr: local.signedXdr };
        remember(current);
        localStorage.removeItem(`${key}:preparing`);
        if (current.state === "paid" || current.state === "failed" || current.state === "reserved") { setMessage(current.message); return; }
        if (!current.prepared) throw new Error("Recover the original preparation; do not create a replacement.");
        if (!current.signedXdr) {
          writeLocal(key, JSON.stringify({ ...current, signing: true }));
          if (Date.parse(current.prepared.expiresAt) <= Date.now()) throw new Error("Original transaction expired. Check its original status; do not create a replacement while unresolved.");
          setMessage("Confirm the recipient-specific payment in Freighter.");
          const signedXdr = await signPrepared(current.prepared, current.payer);
          current = { ...current, signedXdr };
          remember(current); // exact envelope retained BEFORE any submit request
        }
        setMessage("Submitting the original transaction and checking its on-chain payout...");
        const result = await browserRequest<EmergencyPayment>(ENDPOINT, { phase: "submit", request, signedXdr: current.signedXdr });
        remember(result);
        setMessage(result.message);
      });
    } catch (error) {
      setMessage(error instanceof Error ? /prepare again/i.test(error.message) ? "Original transaction could not be signed. Reconnect the approving wallet and check this original payment; do not create a replacement." : error.message : "Payment unresolved. Keep the original request and transaction.");
      try {
        const recovered = await browserRequest<EmergencyPayment | null>(ENDPOINT, { phase: "status", request });
        if (recovered) {
          const saved = localStorage.getItem(key);
          const local: EmergencyPayment | null = saved ? JSON.parse(saved) : null;
          remember(local?.txHash === recovered.txHash && local?.signedXdr && !recovered.signedXdr ? { ...recovered, signedXdr: local.signedXdr } : recovered);
        }
      } catch { /* Leave original envelope and server reservation intact. */ }
    } finally { lock.current = false; setBusy(false); }
  }
  // Submission starts polling without ever opening/signing another wallet operation.
  useEffect(() => {
    if (payment?.state !== "pending" || busy) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await browserRequest<EmergencyPayment>(ENDPOINT, { phase: "status", request: JSON.parse(evidence) });
        if (!cancelled && value) { remember(value); setMessage(value.message); }
      } catch { if (!cancelled) setMessage("Confirmation unavailable. Keep the original payment and check again."); }
      if (!cancelled) timer = setTimeout(poll, 15000);
    }
    timer = setTimeout(poll, 10000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [payment?.state, busy, evidence, key]);
  const label = payment?.state === "paid" ? "Paid" : payment?.state === "failed" ? "Failed" : payment?.state === "pending" || payment?.state === "reserved" ? "Payment Pending" : "Approved";
  const resumable = payment?.state === "prepared" || payment?.state === "pending";
  const canSend = loaded && !busy && !storageBlocked.current && (resumable || integration?.paymentEnabled) && !["paid", "failed", "reserved"].includes(payment?.state ?? "");
  return <>
    <p role="status"><strong>{label}</strong>{payment?.ledger ? ` - confirmed ledger ${payment.ledger}` : ""}</p>
    {payment?.txHash && ["pending", "paid", "failed"].includes(payment.state) && <a className="pp-link-button" href={`https://stellar.expert/explorer/testnet/tx/${payment.txHash}`} target="_blank" rel="noreferrer">View Testnet transaction</a>}
    {!expanded && <button type="button" className="pp-secondary-button" onClick={onReview}>Review emergency payment</button>}
    {expanded && <div className="pp-white-card" role="region" aria-label="Emergency payment confirmation">
      <h2>Confirm emergency payment</h2><p>Recipient: <strong>{EMERGENCY_NAMES[request.requester]}</strong></p><p>Full amount: <strong>{request.amount} USDC</strong></p>
      <p>Recipient wallet: <span className="pp-address">{payment?.wallet ?? integration?.wallet ?? "Checking verified recipient..."}</span></p>
      <p>Deployment: <span className="pp-address">{payment?.deploymentId ?? integration?.deploymentId ?? "Checking deployment..."}</span></p>
      <p>Paying wallet: <span className="pp-address">{payment?.payer ?? request.decision?.signerAddress}</span></p>
      <p role="status">{message || (!loaded ? "Checking the original payment attempt..." : integration?.message ?? "Live deployment verification unavailable.")}</p>
      {payment?.txHash && <p>Original transaction: <span className="pp-address">{payment.txHash}</span></p>}
      <button type="button" className="pp-primary-button" disabled={!canSend} onClick={() => void send()}>{busy ? "Waiting for wallet / confirmation..." : resumable ? payment?.signedXdr ? "Resubmit Original Transaction" : "Sign Original Transaction" : "Send Emergency Funds"}</button>
      <button type="button" className="pp-text-button" disabled={busy} onClick={onClose}>Close</button>
      <p>Testnet only. Payment comes from the approving wallet. Approval does not transfer funds; Paid requires a confirmed USDC payout to this recipient.</p>
    </div>}
  </>;
}

````

## lib/paiflow.ts

````typescript
import "server-only";
import { emergencyConfiguration } from "@/lib/emergency-paiflow";
import type { EmergencyRecipient } from "@/lib/emergency";
import {
  FeeBumpTransaction,
  Networks,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
// starter code, not a supported package — edit freely.

export type Prepared = {
  xdr: string;
  networkPassphrase: string;
  network: "testnet" | "mainnet";
  expiresAt: string;
  preparationRequestId?: string;
  txHash?: string;
};
export type Submitted = {
  txHash: string;
  status: "SUCCESS" | "PENDING" | "FAILED";
  ledger?: number;
  error?: { code: string; message: string };
};
export type ApiFailure = {
  code: string;
  message: string;
  fields?: Record<string, string[]>;
  details?: unknown;
};
export class PaiflowError extends Error {
  constructor(
    readonly status: number,
    readonly api: ApiFailure,
    readonly retryAfter: string | null,
    readonly requestId: string | null,
  ) {
    super(api.message);
  }
}
type Config = { origin: string; deploymentId: string; token: string };
export type Mode = "prepare" | "demo" | "team";
export type PublicConfig =
  | { mode: "prepare" | "demo"; deploymentUrl: null }
  | { mode: "team"; deploymentUrl: string }
  | { mode: "disabled"; deploymentUrl: null; message: string };

function configurationError(message: string): never {
  throw new PaiflowError(503, { code: "CONFIGURATION", message }, null, null);
}
function mode(): Mode {
  const value = process.env.PAIFLOW_MODE?.trim() ?? "prepare";
  if (value === "prepare" || value === "demo" || value === "team") return value;
  return configurationError("Set PAIFLOW_MODE to prepare, demo or team.");
}
function origin() {
  try {
    const url = new URL(
      process.env.PAIFLOW_BASE_URL || "https://beta.app.paiflow.xyz",
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return configurationError("Set PAIFLOW_BASE_URL to a platform origin.");
    return url.origin;
  } catch {
    return configurationError("Set PAIFLOW_BASE_URL to a platform origin.");
  }
}
function teamConfig(): Config {
  const token = process.env.PAIFLOW_API_TOKEN?.trim();
  const deploymentId = process.env.PAIFLOW_DEPLOYMENT_ID?.trim();
  if (!token || !deploymentId)
    return configurationError(
      "Team mode requires PAIFLOW_API_TOKEN and PAIFLOW_DEPLOYMENT_ID.",
    );
  if (!/^pfk_[a-f0-9]{64}$/.test(token))
    return configurationError(
      "Set a valid deployment API token for team mode.",
    );
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      deploymentId,
    )
  )
    return configurationError("Set a valid deployment UUID for team mode.");
  return { origin: origin(), deploymentId, token };
}
export function requireIntegration(): "demo" | "team" {
  const selected = mode();
  switch (selected) {
    case "prepare":
      throw new PaiflowError(
        403,
        {
          code: "PREPARATION_MODE",
          message:
            "Payments and the live feed are disabled in preparation mode.",
        },
        null,
        null,
      );
    case "demo":
      origin();
      return selected;
    case "team":
      teamConfig();
      return selected;
    default: {
      const unreachable: never = selected;
      return unreachable;
    }
  }
}
type Demo = Config & { expires: number };
type DemoCache = { demo?: Demo; minting?: Promise<Demo> };
// Next builds separate route bundles. Share the cache across those bundles and dev reloads.
const processState = globalThis as typeof globalThis & {
  __paiflowDemoCache?: Map<string, DemoCache>;
};
const demoCaches = (processState.__paiflowDemoCache ??= new Map<
  string,
  DemoCache
>());
export function publicConfig(): PublicConfig {
  try {
    const selected = mode();
    switch (selected) {
      case "prepare":
        return { mode: selected, deploymentUrl: null };
      case "demo":
        origin();
        return { mode: selected, deploymentUrl: null };
      case "team": {
        const config = teamConfig();
        return {
          mode: selected,
          deploymentUrl: new URL(
            `/deployments/${config.deploymentId}`,
            config.origin,
          ).href,
        };
      }
      default: {
        const unreachable: never = selected;
        return unreachable;
      }
    }
  } catch (error) {
    if (error instanceof PaiflowError && error.api.code === "CONFIGURATION")
      return { mode: "disabled", deploymentUrl: null, message: error.message };
    throw error;
  }
}
async function config(): Promise<Config> {
  if (requireIntegration() === "team") return teamConfig();
  const platformOrigin = origin();
  const cache = demoCaches.get(platformOrigin) ?? {};
  demoCaches.set(platformOrigin, cache);
  if (cache.demo && Date.now() < cache.demo.expires - 120_000)
    return cache.demo;
  // Single flight: concurrent requests must not consume the 3/hour token allowance.
  if (!cache.minting)
    cache.minting = getDemoToken(platformOrigin)
      .then((value) => {
        const expires = Date.parse(value.expiresAt);
        if (!Number.isFinite(expires) || expires <= Date.now() + 120_000)
          throw new Error("Demo token validity is too short.");
        cache.demo = {
          origin: platformOrigin,
          token: value.token,
          deploymentId: value.deploymentId,
          expires,
        };
        return cache.demo;
      })
      .finally(() => {
        cache.minting = undefined;
      });
  return cache.minting;
}
async function call<T>(
  endpoint: string,
  method: "GET" | "POST",
  body?: unknown,
  query?: URLSearchParams,
  publicPath?: string,
  extraHeaders?: Record<string, string>,
  deploymentConfig?: Config,
): Promise<T> {
  const { origin, deploymentId, token } = deploymentConfig ?? await config();
  const url = new URL(
    publicPath
      ? `api/deployments/${deploymentId}/${publicPath}`
      : ["api", "v1", "deployments", deploymentId, endpoint].join("/"),
    origin + "/",
  );
  if (query) url.search = query.toString();
  const response = await fetch(url, {
    method,
    ...(deploymentConfig ? { signal: AbortSignal.timeout(20000), cache: "no-store" as const } : {}),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const requestId = response.headers.get("x-request-id");
  const unexpected = `Unexpected Paiflow HTTP ${response.status}${requestId ? ` (x-request-id: ${requestId})` : ""}`;
  let result: { data: T } | { error: ApiFailure };
  try {
    result = await response.json();
  } catch {
    throw new PaiflowError(
      response.ok ? 502 : response.status,
      { code: "UPSTREAM_RPC", message: unexpected },
      response.headers.get("Retry-After"),
      requestId,
    );
  }
  if ("error" in result) {
    throw new PaiflowError(
      response.status,
      result.error,
      response.headers.get("Retry-After"),
      requestId,
    );
  }
  if (!response.ok)
    throw new PaiflowError(
      response.ok ? 502 : response.status,
      { code: "UPSTREAM_RPC", message: unexpected },
      response.headers.get("Retry-After"),
      requestId,
    );
  if (
    endpoint === "execute" &&
    response.headers.get("x-history-request-id") &&
    result.data &&
    typeof result.data === "object"
  ) {
    return {
      ...result.data,
      preparationRequestId: response.headers.get("x-history-request-id")!,
    };
  }
  return result.data;
}
// Only expose a boolean to the client; the token and raw capability response stay server-side.
export async function payoutsAvailable(): Promise<boolean> {
  if (requireIntegration() !== "team") return false;
  const capabilities = await call<{
    network?: string;
    operations?: { payouts?: { status?: string } };
  }>("capabilities", "GET");
  const status = capabilities?.operations?.payouts?.status;
  return (
    capabilities?.network === "testnet" &&
    (status === "supported" || status === "conditional")
  );
}

export function executeHash(xdr: string): string {
  try {
    const transaction = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    if (transaction instanceof FeeBumpTransaction)
      throw new Error("Unsupported envelope");
    return Buffer.from(transaction.hash()).toString("hex");
  } catch {
    throw new PaiflowError(
      422,
      {
        code: "VALIDATION",
        message:
          "Invalid original transaction envelope; retain recovery evidence for support.",
      },
      null,
      null,
    );
  }
}
export const prepareExecute = async (input: {
  from: string;
  amount: string;
}) => {
  const prepared = await call<Prepared>("execute", "POST", input);
  if (
    prepared.network !== "testnet" ||
    prepared.networkPassphrase !== Networks.TESTNET
  )
    throw new PaiflowError(
      422,
      { code: "VALIDATION", message: "Only Testnet preparations are allowed." },
      null,
      null,
    );
  return { ...prepared, txHash: executeHash(prepared.xdr) };
};
/** Recover old records from their original envelope, never from a replacement. */
export async function reconcileExecute(xdr: string) {
  const txHash = executeHash(xdr);
  try {
    return { ...(await transactionStatus(txHash)), txHash };
  } catch (error) {
    // Absent deployment association / RPC history is uncertainty, not expiry proof.
    if (
      error instanceof PaiflowError &&
      error.status === 404 &&
      error.api.code === "NOT_FOUND"
    )
      return { status: "UNKNOWN", txHash };
    throw error;
  }
}
export const submitExecute = (
  input: { signedXdr: string },
  wait = true,
  preparationRequestId?: string,
) =>
  call<Submitted>(
    "execute/submit",
    "POST",
    input,
    new URLSearchParams({ wait: String(wait) }),
    undefined,
    preparationRequestId
      ? { "x-preparation-request-id": preparationRequestId }
      : undefined,
  );

export type EventItem = {
  id: string;
  eventId: string;
  kind: string;
  topic: string | null;
  ledger: number;
  txHash: string;
  occurredAt: string;
  data: unknown;
};
export type EventPage = {
  items: EventItem[];
  nextCursor: string | null;
  hasMore: boolean;
};
export function listEvents(
  input: { cursor?: string; limit?: number; txHash?: string } = {},
) {
  const query = new URLSearchParams();
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.txHash) query.set("txHash", input.txHash);
  return call<EventPage>("events", "GET", undefined, query);
}

// One page at a time in your server polling handler:
// const page = await listEvents({ cursor: savedCursor ?? undefined });
// savedCursor = page.nextCursor;
// return page; // browser drains hasMore, then waits before asking again

export const preparePayout = (input: {
  from: string;
  amount: string;
  recipient: string;
  nodeId?: string;
}) => call<Prepared & { nodeId: string }>("payouts", "POST", input);
export const submitPayout = (input: { signedXdr: string }, wait = true) =>
  call<Submitted>(
    "payouts/submit",
    "POST",
    input,
    new URLSearchParams({ wait: String(wait) }),
  );

// Catch PaiflowError in your server handler. For status 409/429, forward status
// and Retry-After to your UI; wait that many seconds before retrying.
// Keep a submitted envelope to retry submitPayout while outcome is uncertain.

export const releaseEarly = (input: { nodeId?: string } = {}) =>
  call<{ nodeId: string; txHash: string; ledger?: number }>(
    "release-early",
    "POST",
    input,
  );
// Teams must add their own authorisation before exposing releaseEarly in a server route.
// The integration adapter requires explicit application authorization.

export async function getOpenApi(origin: string): Promise<unknown> {
  requireIntegration();
  const response = await fetch(new URL("/api/v1/openapi.json", origin));
  if (!response.ok) throw new Error(`OpenAPI HTTP ${response.status}`);
  return response.json();
}
export async function getDemoToken(origin: string) {
  if (requireIntegration() !== "demo")
    throw new PaiflowError(
      403,
      { code: "FORBIDDEN", message: "Demo access requires PAIFLOW_MODE=demo." },
      null,
      null,
    );
  const response = await fetch(new URL("/api/v1/demo-token", origin), {
    method: "POST",
  });
  const body = (await response.json()) as
    | { data: { deploymentId: string; token: string; expiresAt: string } }
    | { error: ApiFailure };
  if ("error" in body)
    throw new PaiflowError(
      response.status,
      body.error,
      response.headers.get("Retry-After"),
      response.headers.get("x-request-id"),
    );
  if (!response.ok) throw new Error(`Demo HTTP ${response.status}`);
  return body.data; // keep token server-side
}

export type {
  DeploymentCapabilities,
  FundingDiscovery,
  ScheduleState,
  SubscriptionState,
} from "@/lib/api-types";
import type {
  DeploymentCapabilities,
  FundingDiscovery,
  FundingPrepare,
  FundingPrepared,
  FundingSubmit,
  FundingReconcile,
  FundingReconciled,
  ScheduleState,
  SchedulePrepared,
  ScheduleReconciled,
  SubscriptionState,
  SubscriptionControlPrepared,
  SubscriptionControlReconciled,
  TransactionStatus,
  DeploymentBalances,
  SwapQuote,
} from "@/lib/api-types";
export const capabilities = () =>
  call<DeploymentCapabilities>("capabilities", "GET");
export const balances = () => call<DeploymentBalances>("balances", "GET");
export const transactionStatus = (txHash: string) =>
  call<TransactionStatus>(`transactions/${encodeURIComponent(txHash)}`, "GET");
export const swapQuote = (input: { amount: string; nodeId?: string }) =>
  call<SwapQuote>(
    "swap-quote",
    "GET",
    undefined,
    new URLSearchParams({
      amountStroops: input.amount,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    }),
  );
export const fundingDiscovery = () => call<FundingDiscovery>("funding", "GET");
export const prepareFunding = (input: FundingPrepare) =>
  call<FundingPrepared>("funding", "POST", input);
export const submitFunding = (input: FundingSubmit) =>
  call<TransactionStatus>("funding/submit", "POST", input);
export const reconcileFunding = (input: FundingReconcile) =>
  call<FundingReconciled>("funding/reconcile", "POST", input);
export const scheduleState = (nodeId?: string) =>
  call<ScheduleState>(
    "schedule/state",
    "GET",
    undefined,
    nodeId ? new URLSearchParams({ nodeId }) : undefined,
  );
export type ScheduleAction = "pause" | "resume" | "retrieve";
export const prepareSchedule = (
  action: ScheduleAction,
  input: { walletAddress: string; nodeId?: string },
) => call<SchedulePrepared>(`schedule/${action}`, "POST", input);
export const submitSchedule = (
  action: ScheduleAction,
  input: { intent: string; signedXdr: string },
) => call<TransactionStatus>(`schedule/${action}/submit`, "POST", input);
export const reconcileSchedule = (
  action: ScheduleAction,
  input: { intent: string },
) => call<ScheduleReconciled>(`schedule/${action}/reconcile`, "POST", input);
export const subscriptionState = () =>
  call<SubscriptionState>("subscription/state", "GET");
export type SubscriptionAction = "cancel" | "reactivate";
export const prepareSubscription = (
  action: SubscriptionAction,
  input: { walletAddress: string },
) =>
  call<SubscriptionControlPrepared>(
    `subscription/${action}/prepare`,
    "POST",
    input,
  );
export const submitSubscription = (
  action: SubscriptionAction,
  input: { intent: string; signedXdr: string },
) => call<TransactionStatus>(`subscription/${action}/submit`, "POST", input);
export const reconcileSubscription = (
  action: SubscriptionAction,
  input: { intent: string },
) =>
  call<SubscriptionControlReconciled>(
    `subscription/${action}/reconcile`,
    "POST",
    input,
  );
export async function prepareAllowance(input: {
  userAddress: string;
  amount: string;
}) {
  const state = await subscriptionState();
  if (state.network !== "testnet")
    configurationError("Only Testnet approvals are allowed.");
  const p = await call<{
    xdr: string;
    intent: string;
    txHash: string;
    networkPassphrase: string;
  }>("", "POST", input, undefined, "subscription-allowance");
  // Public approval response omits expiry/network. Its platform-signed intent
  // embeds the transaction maxTime; platform validates the MAC on submit/status.
  const metadata: unknown = JSON.parse(
    Buffer.from(p.intent.split(".")[0] ?? "", "base64url").toString("utf8"),
  );
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("maxTime" in metadata) ||
    typeof metadata.maxTime !== "string" ||
    !/^[1-9]\d{0,12}$/.test(metadata.maxTime)
  )
    configurationError(
      "Approval expiry metadata is unavailable; contact platform support.",
    );
  return {
    ...p,
    network: state.network,
    expiresAt: new Date(Number(metadata.maxTime) * 1000).toISOString(),
  };
}
export const submitAllowance = (input: { intent: string; signedXdr: string }) =>
  call<TransactionStatus>(
    "",
    "POST",
    input,
    undefined,
    "subscription-allowance/submit",
  );
export const allowanceStatus = (intent: string) =>
  call<TransactionStatus>(
    "",
    "GET",
    undefined,
    new URLSearchParams({ intent }),
    "subscription-allowance/status",
  );

export type WebhookReward = {
  key: string;
  payload: { escrow: true; amount?: string };
};
// Save this record in your database against the logical completed event BEFORE
// calling. Load it unchanged on retry. Never generate a new key after uncertainty.
export async function webhookReward(record: WebhookReward) {
  if (requireIntegration() !== "team")
    configurationError("Webhook rewards require team mode.");
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(record.key) ||
    record.payload.escrow !== true ||
    (record.payload.amount !== undefined &&
      (!/^(0|[1-9]\d{0,38})$/.test(record.payload.amount) ||
        BigInt(record.payload.amount) > (1n << 127n) - 1n))
  )
    configurationError("Invalid stable Webhook reward record.");
  const secret = process.env.PAIFLOW_WEBHOOK_SECRET;
  if (!secret)
    configurationError("Configure server-only PAIFLOW_WEBHOOK_SECRET.");
  const c = teamConfig();
  if ((await capabilities()).network !== "testnet")
    configurationError("Only Testnet callbacks are allowed.");
  const response = await fetch(
    new URL(`/api/webhooks/${c.deploymentId}`, c.origin),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": secret,
        "Idempotency-Key": record.key,
      },
      body: JSON.stringify(record.payload),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new PaiflowError(
      response.status,
      result.error ?? {
        code: "UPSTREAM_RPC",
        message:
          "Callback outcome unresolved; retry the saved key and payload.",
      },
      response.headers.get("Retry-After"),
      response.headers.get("x-request-id"),
    );
  return result.data as {
    attemptId: string;
    network: string;
    status: string;
    txHash?: string;
  };
}

export function integrationOrigin() {
  requireIntegration();
  return origin();
}

// Dedicated emergency client. Every call is bound to the server recipient mapping;
// no demo/global Instant deployment fallback and no client-supplied upstream path.
export function emergencyPaiflow(recipient: EmergencyRecipient) {
  if (mode() !== "team") configurationError("Emergency payments require team mode.");
  const selected = { ...emergencyConfiguration(recipient), origin: origin() };
  return {
    capabilities: () => call<DeploymentCapabilities>("capabilities", "GET", undefined, undefined, undefined, undefined, selected),
    prepare: (from: string, amount: string) => call<Prepared>("execute", "POST", { from, amount }, undefined, undefined, undefined, selected),
    submit: (signedXdr: string, preparationRequestId?: string) => call<Submitted>("execute/submit", "POST", { signedXdr }, new URLSearchParams({ wait: "false" }), undefined, preparationRequestId ? { "x-preparation-request-id": preparationRequestId } : undefined, selected),
    status: (txHash: string) => call<TransactionStatus>(`transactions/${encodeURIComponent(txHash)}`, "GET", undefined, undefined, undefined, undefined, selected),
  };
}

````

## lib/emergency.ts

````typescript
import { fromStroops, toStroops } from "@/lib/amount";

export const EMERGENCY_RECIPIENTS = ["parents", "brother", "sister"] as const;
export type EmergencyRecipient = typeof EMERGENCY_RECIPIENTS[number];
export type Approver = string;
export const EMERGENCY_NAMES: Record<EmergencyRecipient | "jun", string> = { parents: "Parents", brother: "Brother", sister: "Younger Sister", jun: "Jun" };
export type EmergencyStatus = "pending" | "approved" | "rejected" | "payment_pending" | "paid" | "failed";
export type EmergencyRequest = {
  id: string;
  requester: EmergencyRecipient;
  amount: string;
  reason: string;
  createdAt: string;
  approvals: Approver[];
  status: EmergencyStatus;
  decision?: { signerAddress: string; signature: string; origin: string; approve: boolean };
};
export function isEmergencyRecipient(value: unknown): value is EmergencyRecipient {
  return EMERGENCY_RECIPIENTS.some(id => id === value);
}
export function emergencyAmount(value: string, maximum = "10000"): string {
  const stroops = toStroops(value);
  if (BigInt(stroops) > BigInt(toStroops(maximum))) throw new Error(`Maximum emergency request is ${maximum} USDC.`);
  return fromStroops(stroops);
}
export function createRequest(requester: unknown, amount: string, reason: string): EmergencyRequest {
  if (!isEmergencyRecipient(requester)) throw new Error("Select a supported emergency recipient.");
  if (!reason.trim() || reason.trim().length > 180) throw new Error("Enter a reason of 1?180 characters.");
  return { id: crypto.randomUUID(), requester, amount: emergencyAmount(amount), reason: reason.trim(), createdAt: new Date().toISOString(), approvals: [], status: "pending" };
}
export function decisionMessage(request: EmergencyRequest, approve: boolean, origin: string): string {
  return JSON.stringify({ application: "Padala Pabalik Emergency Approval", version: 1, network: "testnet", origin, decision: approve ? "approve" : "reject", requestId: request.id, requester: request.requester, amountUSDC: request.amount, reason: request.reason, createdAt: request.createdAt });
}
export function decideRequest(request: EmergencyRequest, approver: string, approve: boolean): EmergencyRequest {
  if (request.status !== "pending") throw new Error("Only pending requests can be reviewed.");
  if (!/^G[A-Z2-7]{55}$/.test(approver)) throw new Error("Connect a Stellar wallet to review this request.");
  return { ...request, approvals: approve ? [approver] : [], status: approve ? "approved" : "rejected" };
}
export function readRequests(raw: string): EmergencyRequest[] {
  const items: unknown = JSON.parse(raw);
  if (!Array.isArray(items)) throw new Error("Invalid emergency history. Preserve the original storage for recovery.");
  return items.map((item: EmergencyRequest) => {
    if (!item || typeof item.id !== "string" || !/^[a-f0-9-]{36}$/i.test(item.id) || !isEmergencyRecipient(item.requester) || typeof item.amount !== "string" || emergencyAmount(item.amount) !== item.amount || typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 180 || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) || !Array.isArray(item.approvals) || !["pending", "approved", "rejected"].includes(item.status)) throw new Error("Invalid emergency history; payment statuses cannot be restored from approval records.");
    // Old simulated decisions lack wallet signatures. Preserve requests, reset review.
    if (!item.decision) return { ...item, approvals: [], status: "pending" };
    const proof = item.decision;
    if (typeof proof.signerAddress !== "string" || !/^G[A-Z2-7]{55}$/.test(proof.signerAddress) || typeof proof.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(proof.signature) || typeof proof.origin !== "string" || proof.origin.length > 200 || typeof proof.approve !== "boolean" || item.status !== (proof.approve ? "approved" : "rejected") || item.approvals.length !== (proof.approve ? 1 : 0) || (proof.approve && item.approvals[0] !== proof.signerAddress)) throw new Error("Invalid wallet decision evidence.");
    return item;
  });
}
export type EmergencyIntegration = {
  recipient: EmergencyRecipient;
  deploymentId: string | null;
  configured: boolean;
  paymentEnabled: boolean;
  wallet?: string;
  trigger?: string;
  message: string;
};

export type EmergencyPayment = {
  state: "reserved" | "prepared" | "pending" | "paid" | "failed" | "refused";
  requestId: string;
  deploymentId: string;
  wallet: string;
  amount: string;
  payer: string;
  txHash?: string;
  prepared?: { xdr: string; network: "testnet"; networkPassphrase: string; expiresAt: string; txHash: string; preparationRequestId?: string };
  signedXdr?: string;
  ledger?: number;
  message: string;
};

````

## lib/emergency-paiflow.ts

````typescript
import "server-only";
import { isEmergencyRecipient, type EmergencyIntegration, type EmergencyRecipient } from "@/lib/emergency";

const PREFIXES: Record<EmergencyRecipient, string> = {
  parents: "PAIFLOW_EMERGENCY_POT_PARENT",
  brother: "PAIFLOW_EMERGENCY_POT_BROTHER",
  sister: "PAIFLOW_EMERGENCY_POT_SISTER",
};
const EXPECTED_IDS: Record<EmergencyRecipient, string> = {
  parents: "3f61d495-5bfa-4f51-b4e3-f666fc7bf22d",
  brother: "d34c35d4-10e0-4b59-9b98-425a1a503023",
  sister: "73ebc55f-1a70-4ddd-8172-b05489871c85",
};
// Credentials stay in this server-only module. No fallback to the Instant deployment.
export function emergencyConfiguration(recipient: unknown) {
  if (!isEmergencyRecipient(recipient)) throw new Error("Unsupported emergency recipient.");
  const prefix = PREFIXES[recipient];
  const deploymentId = process.env[`${prefix}_DEPLOYMENT_ID`]?.trim();
  const token = process.env[`${prefix}_API_TOKEN`]?.trim();
  if (deploymentId !== EXPECTED_IDS[recipient] || !token || !/^pfk_[a-f0-9]{64}$/.test(token)) throw new Error("Emergency deployment configuration is missing or invalid.");
  if (deploymentId === process.env.PAIFLOW_DEPLOYMENT_ID?.trim()) throw new Error("Emergency deployment must be separate from Instant Padala.");
  return { deploymentId, token };
}
export function emergencyIntegration(recipient: EmergencyRecipient): EmergencyIntegration {
  try {
    const { deploymentId } = emergencyConfiguration(recipient);
    return { recipient, deploymentId, configured: true, paymentEnabled: false, message: "Checking live emergency deployment and on-chain recipient configuration before payment." };
  } catch {
    return { recipient, deploymentId: null, configured: false, paymentEnabled: false, message: "Payment disabled: configure this recipient's server-only deployment ID and API token, then verify the deployed recipient and funding destination." };
  }
}

````

## lib/emergency-approval.ts

````typescript
import "server-only";
import { Keypair, hash } from "@stellar/stellar-sdk";
import { decisionMessage, decideRequest, type EmergencyRequest } from "@/lib/emergency";

export function verifyWalletSignature(message: string, signature: string, signerAddress: string): boolean {
  try {
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    const digest = hash(Buffer.from(`Stellar Signed Message:\n${message}`, "utf8"));
    return Keypair.fromPublicKey(signerAddress).verify(digest, Buffer.from(signature, "base64"));
  } catch { return false; }
}
export function verifyDecision(request: EmergencyRequest, origin: string): EmergencyRequest {
  const proof = request.decision;
  if (!proof || proof.origin !== origin || !verifyWalletSignature(decisionMessage(request, proof.approve, origin), proof.signature, proof.signerAddress)) throw new Error("Approval signature is missing, invalid, or belongs to another site.");
  return { ...decideRequest({ ...request, status: "pending", approvals: [], decision: undefined }, proof.signerAddress, proof.approve), decision: proof };
}

````

## lib/emergency-chain.ts

````typescript
import "server-only";
import { Address, Asset, FeeBumpTransaction, Networks, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { EmergencyRecipient } from "@/lib/emergency";
import { toStroops } from "@/lib/amount";
import type { Prepared } from "@/lib/paiflow";

export const EMERGENCY_TARGETS = {
  parents: { trigger: "CA4D6A6TV53ESGHWEXV5VMSFGFV4SXSELTDUSYJIA47RU4NNDHGW3INV", pay: "CDWHILTEQ5KMONWZ3XQML3ISFBLSYMF65GRYPQT2T67BU32QBKBJJXKO", wallet: "GBRHKU2LZNDPRCVXXPFZZ3XNS5DEWGTA4AVCPDER2RHY56EKOQ2EWMJK" },
  brother: { trigger: "CDL2M5WIGG7HFH2BFL4XZOWHN3WK7BRYZCH5YFT2N3FBFDE2IJKRW7C4", pay: "CA6NKUJGJG4YQEVPN6NTXXEN7MO42L5OA4A2JVCYNOMMGFP66G2EIS2H", wallet: "GAWW3W5X5YETABCWRA4NBIOTX46YGFO5H3NEUHQCORW7PCE7ZYUAPLNB" },
  sister: { trigger: "CCQIVWQOVORC57J2PPZZ54NECNYKLH76UWSTM5DOGO4GBLEPJ3IM7OS6", pay: "CDHOU6GFDTFIBADEKF4FEKSGZOT2HTLKMOH5OTYK2SROCH73VN5FKXGE", wallet: "GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX" },
} satisfies Record<EmergencyRecipient, { trigger: string; pay: string; wallet: string }>;
const TRIGGER_WASM = "472061679c6b6fc313f70107c09ed7ca3d21ccd0aef15b082c2533632ee75602";
const PAY_WASM = "b331db1c3e26da4fe8aec7635a567a11fb5e069123c355eaae92d095d5ef457f";
export const EMERGENCY_USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5").contractId(Networks.TESTNET);
export const emergencyRpc = new rpc.Server("https://soroban-testnet.stellar.org", { timeout: 20000 });
function requireMatch(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function instance(contract: string, wasm: string) {
  const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(contract).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent }));
  const response = await emergencyRpc.getLedgerEntries(key);
  const entry = response.entries[0];
  requireMatch(entry?.val.type === "contractData" && entry.val.contractData.val.type === "scvContractInstance", "Contract configuration unavailable.");
  const state = entry.val.contractData.val.instance;
  requireMatch(state.executable.type === "contractExecutableWasm" && Buffer.from(state.executable.wasmHash.value).toString("hex") === wasm, "Deployed contract code changed; review required.");
  const fields: Record<string, unknown> = {};
  for (const pair of state.storage ?? []) { const [name] = scValToNative(pair.key) as string[]; if (name) fields[name] = scValToNative(pair.val); }
  return fields;
}
export async function verifyEmergencyTarget(recipient: EmergencyRecipient) {
  const target = EMERGENCY_TARGETS[recipient];
  const [trigger, pay] = await Promise.all([instance(target.trigger, TRIGGER_WASM), instance(target.pay, PAY_WASM)]);
  const steps = trigger.NextSteps as { address: string; data: string }[] | undefined;
  requireMatch(trigger.Version === 1 && trigger.Asset === EMERGENCY_USDC && Array.isArray(steps) && steps.length === 1 && steps[0]?.address === target.pay && steps[0]?.data === "", "Emergency trigger topology or asset changed.");
  requireMatch(pay.Version === 4 && pay.Asset === EMERGENCY_USDC && pay.Recipient === target.wallet && pay.Amount === 0n && pay.PercentageBps === 10000 && pay.IsCashOut === false && pay.ParentNode === target.trigger && Array.isArray(pay.NextSteps) && pay.NextSteps.length === 0, "Emergency Pay recipient or full-amount configuration changed.");
  return target;
}
export function validateEmergencyEnvelope(xdrText: string, recipient: EmergencyRecipient, payer: string, amount: string) {
  const tx = TransactionBuilder.fromXDR(xdrText, Networks.TESTNET);
  requireMatch(!(tx instanceof FeeBumpTransaction) && tx.source === payer && tx.operations.length === 1 && tx.memo.type === "none", "Wrong payment source or envelope operations.");
  const op = tx.operations[0];
  requireMatch(op?.type === "invokeHostFunction" && (!op.source || op.source === payer) && op.func.type === "hostFunctionTypeInvokeContract", "Expected one deposit invocation.");
  const call = op.func.invokeContract;
  requireMatch(Address.fromScAddress(call.contractAddress).toString() === EMERGENCY_TARGETS[recipient].trigger && call.functionName.toString() === "deposit" && call.args.length === 2 && scValToNative(call.args[0]!) === payer && scValToNative(call.args[1]!) === BigInt(toStroops(amount)), "Prepared payment does not match the approved emergency request.");
  requireMatch((op.auth ?? []).every(entry => entry.credentials.type === "sorobanCredentialsSourceAccount"), "Unexpected independent authorization entries.");
  requireMatch(BigInt(tx.fee) <= 100000000n && !!tx.timeBounds && BigInt(tx.timeBounds.maxTime) > 0n, "Unexpected fee or unbounded payment lifetime.");
  return tx;
}
export function validateEmergencyPreparation(prepared: Prepared, recipient: EmergencyRecipient, payer: string, amount: string) {
  requireMatch(prepared.network === "testnet" && prepared.networkPassphrase === Networks.TESTNET, "Only Testnet payments are allowed.");
  const tx = validateEmergencyEnvelope(prepared.xdr, recipient, payer, amount);
  const expires = Date.parse(prepared.expiresAt);
  requireMatch(Number.isFinite(expires) && expires > Date.now() && Math.abs(expires - Number(tx.timeBounds!.maxTime) * 1000) <= 1000 && expires <= Date.now() + 10 * 60 * 1000 && tx.signatures.length === 0, "Invalid payment expiry or pre-signed preparation.");
  return { xdr: prepared.xdr, network: "testnet" as const, networkPassphrase: Networks.TESTNET, expiresAt: new Date(expires).toISOString(), txHash: Buffer.from(tx.hash()).toString("hex"), ...(prepared.preparationRequestId && /^[a-f0-9-]{36}$/i.test(prepared.preparationRequestId) ? { preparationRequestId: prepared.preparationRequestId } : {}) };
}
export function payoutEventsMatch(events: xdr.ContractEvent[], recipient: EmergencyRecipient, payer: string, amount: string): boolean {
  const target = EMERGENCY_TARGETS[recipient];
  const transfers: string[] = [];
  for (const event of events) {
    if (!event.contractId || Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(event.contractId)).toString() !== EMERGENCY_USDC || event.body.type !== "v0") continue;
    const topics = event.body.v0.topics.map(scValToNative);
    if (topics[0] === "transfer") transfers.push(JSON.stringify([topics[1], topics[2], String(scValToNative(event.body.v0.data))]));
  }
  const stroops = toStroops(amount);
  const expected = [[payer, target.trigger, stroops], [target.trigger, target.pay, stroops], [target.pay, target.wallet, stroops]].map(value => JSON.stringify(value)).sort();
  return JSON.stringify(transfers.sort()) === JSON.stringify(expected);
}
export async function confirmedEmergencyPayment(txHash: string, recipient: EmergencyRecipient, payer: string, amount: string) {
  const result = await emergencyRpc.getTransaction(txHash);
  if (result.status === "NOT_FOUND") return { status: "UNKNOWN" as const };
  requireMatch(result.txHash === txHash && !result.feeBump, "Transaction confirmation mismatch.");
  if (result.status === "FAILED") return { status: "FAILED" as const, ledger: result.ledger };
  const tx = TransactionBuilder.fromXDR(result.envelopeXdr, Networks.TESTNET);
  requireMatch(Buffer.from(tx.hash()).toString("hex") === txHash, "Confirmed transaction hash mismatch.");
  validateEmergencyEnvelope(tx.toXDR(), recipient, payer, amount);
  if (!payoutEventsMatch(result.events.contractEventsXdr.flat(), recipient, payer, amount)) return { status: "UNKNOWN" as const };
  return { status: "SUCCESS" as const, ledger: result.ledger };
}

````

## lib/emergency-store.ts

````typescript
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { EmergencyPayment, EmergencyRequest } from "@/lib/emergency";

export type EmergencyAttempt = EmergencyPayment & { version: 1; request: EmergencyRequest; origin: string; updatedAt: string };
export class EmergencyConflict extends Error {}
// Single durable filesystem shared by this local Node server. Never put this on an
// ephemeral/serverless filesystem or split it between deployment instances.
const directory = () => path.join(process.cwd(), ".data", "emergency-payments");
export async function withEmergencyAttempt<T>(origin: string, requestId: string, action: (attempt: EmergencyAttempt | null, save: (attempt: EmergencyAttempt) => Promise<void>) => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(`${origin}:${requestId}`).digest("hex");
  const root = directory();
  await mkdir(root, { recursive: true });
  const file = path.join(root, `${key}.json`);
  const lockPath = path.join(root, `${key}.lock`);
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new EmergencyConflict("Another payment operation is running, or its server lock needs operator review. Recheck the original attempt; do not replace it."); throw error; }
  try {
    let attempt: EmergencyAttempt | null = null;
    try {
      attempt = JSON.parse(await readFile(file, "utf8"));
      if (!attempt || attempt.version !== 1 || attempt.requestId !== requestId || attempt.origin !== origin) throw new Error("Invalid durable payment record.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    async function save(record: EmergencyAttempt) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ ...record, updatedAt: new Date().toISOString() })); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    }
    return await action(attempt, save);
  } finally { await lock.close(); await unlink(lockPath); }
}
export function publicEmergencyAttempt(attempt: EmergencyAttempt): EmergencyPayment {
  const { state, requestId, deploymentId, wallet, amount, payer, txHash, prepared, signedXdr, ledger, message } = attempt;
  return { state, requestId, deploymentId, wallet, amount, payer, txHash, prepared, signedXdr, ledger, message };
}

````

## lib/emergency-payments.ts

````typescript
import "server-only";
import { Keypair } from "@stellar/stellar-sdk";
import { decisionMessage, type EmergencyIntegration, type EmergencyRecipient, type EmergencyRequest } from "@/lib/emergency";
import { toStroops } from "@/lib/amount";
import { verifyDecision } from "@/lib/emergency-approval";
import { emergencyConfiguration, emergencyIntegration } from "@/lib/emergency-paiflow";
import { emergencyPaiflow, PaiflowError } from "@/lib/paiflow";
import { EMERGENCY_TARGETS, confirmedEmergencyPayment, validateEmergencyEnvelope, validateEmergencyPreparation, verifyEmergencyTarget } from "@/lib/emergency-chain";
import { withEmergencyAttempt, publicEmergencyAttempt, EmergencyConflict, type EmergencyAttempt } from "@/lib/emergency-store";

export class EmergencyPaymentError extends Error {
  constructor(message: string, readonly status = 422, readonly code = "VALIDATION") { super(message); }
}
function approved(request: EmergencyRequest, origin: string) {
  const verified = verifyDecision(request, origin);
  if (verified.status !== "approved" || !verified.decision?.approve || verified.approvals.length !== 1) throw new EmergencyPaymentError("One verified wallet approval is required before payment.");
  return verified;
}
export async function emergencyDiscovery(recipient: EmergencyRecipient): Promise<EmergencyIntegration> {
  const configured = emergencyIntegration(recipient);
  if (!configured.configured) return configured;
  try {
    const deployment = emergencyConfiguration(recipient);
    const api = emergencyPaiflow(recipient);
    const [capabilities, target] = await Promise.all([api.capabilities(), verifyEmergencyTarget(recipient)]);
    if (capabilities.deploymentId !== deployment.deploymentId || capabilities.network !== "testnet" || capabilities.triggerType !== "deposit" || capabilities.inputAsset?.kind !== "known" || capabilities.inputAsset.symbol !== "USDC" || !["supported", "conditional"].includes(capabilities.operations.execute.status)) throw new Error("Deployment capability mismatch.");
    return { ...configured, ...target, paymentEnabled: true, message: "Recipient and full-amount Testnet USDC route verified. Freighter will authorize a separate payment from the approving wallet." };
  } catch {
    return { ...configured, paymentEnabled: false, message: "Payment unavailable: live deployment/contract verification failed or team mode is disabled. Check configuration and try refreshing." };
  }
}
function definitelyRefused(error: unknown) {
  return error instanceof PaiflowError && error.status >= 400 && error.status < 500 && ["VALIDATION", "FORBIDDEN", "UNAUTHENTICATED", "PREPARATION_MODE", "CONFIGURATION", "RATE_LIMITED", "INSUFFICIENT_FUNDS"].includes(error.api.code);
}
function preparationFailure(error: unknown) {
  if (error instanceof PaiflowError && error.api.code === "INSUFFICIENT_FUNDS") return "Preparation refused: check Testnet USDC balance and XLM for fees.";
  if (error instanceof PaiflowError && error.api.code === "RATE_LIMITED") return "Preparation refused: Paiflow rate limit reached. Wait before trying again.";
  if (definitelyRefused(error)) return "Preparation refused: check Testnet account funding, exact USDC trustlines and deployment eligibility. No transaction was signed.";
  return "Preparation unresolved. The original request is reserved; check its payment status before any other attempt.";
}
async function reconcile(attempt: EmergencyAttempt) {
  if (attempt.state === "paid" || attempt.state === "failed" || !attempt.txHash) return attempt;
  try {
    const upstream = await emergencyPaiflow(attempt.request.requester).status(attempt.txHash).catch(() => null);
    if (upstream && (upstream.txHash !== attempt.txHash || upstream.network !== "testnet")) throw new Error("Status response mismatch.");
    const proof = await confirmedEmergencyPayment(attempt.txHash, attempt.request.requester, attempt.payer, attempt.amount);
    if (proof.status === "SUCCESS") return { ...attempt, state: "paid" as const, ledger: proof.ledger, message: "Paid: confirmed Testnet USDC transfer of the exact amount to the intended recipient." };
    if (proof.status === "FAILED") return { ...attempt, state: "failed" as const, ledger: proof.ledger, message: "The transaction failed on-chain. No emergency payout succeeded. This attempt remains in history." };
    return { ...attempt, message: attempt.state === "prepared" ? "Original payment prepared. Sign this same transaction to continue; an expired or uncertain preparation is never silently replaced." : "Payment pending or outcome unknown. Keep the original transaction; check again rather than starting another payment." };
  } catch {
    return { ...attempt, message: "Confirmation temporarily unavailable. Keep the original transaction and check again; no replacement payment is allowed." };
  }
}
export async function emergencyPayment(request: EmergencyRequest, origin: string, phase: "prepare" | "submit" | "status", signedXdr?: string) {
  const verified = approved(request, origin);
  const config = emergencyConfiguration(verified.requester);
  // Enforce mode before accepting payment work, including recovery requests.
  const api = emergencyPaiflow(verified.requester);
  return withEmergencyAttempt(origin, verified.id, async (existing, save) => {
    if (existing && (existing.deploymentId !== config.deploymentId || existing.payer !== verified.decision!.signerAddress || decisionMessage(existing.request, true, origin) !== decisionMessage(verified, true, origin))) throw new EmergencyPaymentError("This request ID is already bound to another immutable payment.", 409, "CONFLICT");
    if (phase === "status") {
      if (!existing) return null;
      const next = await reconcile(existing); await save(next);
      return publicEmergencyAttempt(next);
    }
    if (phase === "prepare") {
      if (existing && existing.state !== "refused") return publicEmergencyAttempt(existing);
      const readiness = await emergencyDiscovery(verified.requester);
      if (!readiness.paymentEnabled) throw new EmergencyPaymentError(readiness.message, 503, "CONFIGURATION");
      let attempt: EmergencyAttempt = { version: 1, origin, request: verified, requestId: verified.id, deploymentId: config.deploymentId, payer: verified.decision!.signerAddress, wallet: EMERGENCY_TARGETS[verified.requester].wallet, amount: verified.amount, state: "reserved", message: "Original payment preparation reserved.", updatedAt: new Date().toISOString() };
      // Persist the reservation BEFORE touching a preparation API. If its response is
      // lost, another process/reload can never create a replacement for this request.
      await save(attempt);
      try {
        const prepared = validateEmergencyPreparation(await api.prepare(attempt.payer, toStroops(attempt.amount)), verified.requester, attempt.payer, attempt.amount);
        attempt = { ...attempt, prepared, txHash: prepared.txHash, state: "prepared", message: "Ready for Freighter confirmation. No payment has been submitted." };
        await save(attempt);
        return publicEmergencyAttempt(attempt);
      } catch (error) {
        const refused = definitelyRefused(error);
        await save({ ...attempt, state: refused ? "refused" : "reserved", message: preparationFailure(error) });
        throw new EmergencyPaymentError(preparationFailure(error), refused ? 422 : 503, refused ? "VALIDATION" : "UPSTREAM_RPC");
      }
    }
    if (!existing?.prepared || !existing.txHash) throw new EmergencyPaymentError("Recover the original preparation before submission.", 409, "CONFLICT");
    if (existing.state === "paid" || existing.state === "failed") return publicEmergencyAttempt(existing);
    if (!signedXdr) throw new EmergencyPaymentError("A signed payment transaction is required.");
    if (existing.signedXdr && existing.signedXdr !== signedXdr) throw new EmergencyPaymentError("Only the original signed envelope may be resubmitted.", 409, "CONFLICT");
    const tx = validateEmergencyEnvelope(signedXdr, verified.requester, existing.payer, existing.amount);
    if (Buffer.from(tx.hash()).toString("hex") !== existing.txHash || !tx.signatures.some(signature => Keypair.fromPublicKey(existing.payer).verify(tx.hash(), signature.signature.value))) throw new EmergencyPaymentError("The approving wallet must sign the original prepared transaction.");
    await verifyEmergencyTarget(verified.requester);
    // Exact signed envelope and possible-submission marker are durable before submit.
    let attempted: EmergencyAttempt = { ...existing, signedXdr, state: "pending", message: "Payment submitted or submission outcome unresolved. Check the original transaction." };
    await save(attempted);
    try {
      const result = await api.submit(signedXdr, existing.prepared.preparationRequestId);
      if (result.txHash !== existing.txHash) throw new Error("Submission hash mismatch.");
      // HTTP 200 or SUCCESS alone does not mark Paid. Independent RPC confirmation
      // must include the exact payer->trigger->Pay->recipient USDC transfer chain.
      attempted = await reconcile(attempted);
    } catch {
      attempted.message = "Submission outcome unresolved. The original signed transaction was saved; check status or resubmit that same envelope only.";
    }
    await save(attempted);
    return publicEmergencyAttempt(attempted);
  });
}
export { EmergencyConflict };

````

## app/api/emergency/integration/route.ts

````typescript
import { EMERGENCY_RECIPIENTS, isEmergencyRecipient, readRequests } from "@/lib/emergency";
import { emergencyDiscovery, emergencyPayment, EmergencyConflict, EmergencyPaymentError } from "@/lib/emergency-payments";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  const known = error instanceof EmergencyPaymentError || error instanceof EmergencyConflict;
  return Response.json({ error: { code: error instanceof EmergencyPaymentError ? error.code : error instanceof EmergencyConflict ? "CONFLICT" : "UPSTREAM_RPC", message: known ? error.message : "Emergency payment could not be completed. Retain the original request and check its payment status." } }, { status: error instanceof EmergencyPaymentError ? error.status : error instanceof EmergencyConflict ? 409 : 503, headers: { "Cache-Control": "no-store" } });
}
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== "recipient") || (query.has("recipient") && !isEmergencyRecipient(query.get("recipient")))) return Response.json({ error: { code: "VALIDATION", message: "Unsupported emergency recipient or query." } }, { status: 422 });
  const recipients = query.has("recipient") ? [query.get("recipient")!] : EMERGENCY_RECIPIENTS;
  try { return Response.json({ data: await Promise.all(recipients.map(recipient => emergencyDiscovery(recipient as typeof EMERGENCY_RECIPIENTS[number]))) }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  if (request.headers.get("origin") !== origin) return Response.json({ error: { code: "FORBIDDEN", message: "Same-origin requests required." } }, { status: 403 });
  let body;
  try {
    const text = await request.text();
    if (text.length > 220000) throw new Error("Payload too large.");
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["phase", "request", "signedXdr"].includes(key)) || !["prepare", "submit", "status"].includes(body.phase) || (body.signedXdr !== undefined && (typeof body.signedXdr !== "string" || body.signedXdr.length > 200000)) || (body.phase !== "submit" && body.signedXdr !== undefined)) throw new Error("Invalid fields.");
    const [record] = readRequests(JSON.stringify([body.request]));
    if (!record || record.status !== "approved") throw new Error("Only approved requests can enter payment.");
    return Response.json({ data: await emergencyPayment(record, origin, body.phase, body.signedXdr) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (!body || !(error instanceof EmergencyPaymentError || error instanceof EmergencyConflict)) {
      // Validation/signature/configuration errors never expose arbitrary input or
      // upstream details. Recovery stays in the durable request record.
      return failure(new EmergencyPaymentError("Invalid or unavailable approved payment. Verify its wallet approval, configuration and original payment status."));
    }
    return failure(error);
  }
}

````

## app/api/emergency/approval/route.ts

````typescript
import { decisionMessage, decideRequest, readRequests, type EmergencyRequest } from "@/lib/emergency";
import { verifyDecision, verifyWalletSignature } from "@/lib/emergency-approval";

export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  if (request.headers.get("origin") !== origin) return Response.json({ error: { code: "FORBIDDEN", message: "Same-origin requests required." } }, { status: 403 });
  try {
    if (Number(request.headers.get("content-length")) > 16000) throw new Error("Approval payload too large.");
    const raw = await request.text();
    if (raw.length > 16000) throw new Error("Approval payload too large.");
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["request", "signature", "signerAddress", "approve", "verify"].includes(key))) throw new Error("Invalid approval fields.");
    if (body.verify === true) {
      const [record] = readRequests(JSON.stringify([body.request]));
      if (!record) throw new Error("Missing request.");
      return Response.json({ data: verifyDecision(record, origin) }, { headers: { "Cache-Control": "no-store" } });
    }
    const [record] = readRequests(JSON.stringify([body.request]));
    if (!record) throw new Error("Missing request.");
    if (record.status !== "pending" || typeof body.approve !== "boolean" || typeof body.signature !== "string" || typeof body.signerAddress !== "string") throw new Error("A pending request and wallet signature are required.");
    if (!verifyWalletSignature(decisionMessage(record, body.approve, origin), body.signature, body.signerAddress)) return Response.json({ error: { code: "FORBIDDEN", message: "The active wallet's signature could not be verified." } }, { status: 403 });
    const decided: EmergencyRequest = { ...decideRequest(record, body.signerAddress, body.approve), decision: { signerAddress: body.signerAddress, signature: body.signature, origin, approve: body.approve } };
    return Response.json({ data: decided }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: { code: "VALIDATION", message: "Invalid request or wallet decision evidence." } }, { status: 422 });
  }
}

````

## tests/emergency.test.ts

````typescript
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createRequest, decideRequest, readRequests, emergencyAmount, decisionMessage } from "@/lib/emergency";
import { emergencyConfiguration, emergencyIntegration } from "@/lib/emergency-paiflow";
import { GET, POST } from "@/app/api/emergency/integration/route";

import { Keypair, hash } from "@stellar/stellar-sdk";
import { POST as approveRequest } from "@/app/api/emergency/approval/route";
import { verifyWalletSignature } from "@/lib/emergency-approval";
const wallet = Keypair.random();
const origin = "http://localhost";
function signedBody(record: ReturnType<typeof createRequest>, approve = true) {
  const signature = Buffer.from(wallet.sign(hash(Buffer.from(`Stellar Signed Message:\n${decisionMessage(record, approve, origin)}`)))).toString("base64");
  return { request: record, approve, signature, signerAddress: wallet.publicKey() };
}
function post(body: unknown, site = origin) {
  return approveRequest(new Request(`${origin}/api/emergency/approval`, { method: "POST", headers: { origin: site, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}
describe("active wallet emergency approval", () => {
  it.each(["parents", "brother", "sister"])("approves %s with one wallet signature and preserves the request", async recipient => {
    const original = createRequest(recipient, "50", "Medical bill");
    const response = await post(signedBody(original));
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data).toMatchObject({ requester: recipient, amount: "50", reason: "Medical bill", status: "approved", approvals: [wallet.publicKey()] });
    expect(readRequests(JSON.stringify([data]))).toEqual([data]);
    expect(() => decideRequest(data, wallet.publicKey(), true)).toThrow();
    expect((await post({ request: data, verify: true })).status).toBe(200);
  });
  it("rejects altered amounts, forged signer addresses, and wrong origins", async () => {
    const body = signedBody(createRequest("brother", "50", "Need support"));
    expect((await post({ ...body, request: { ...body.request, amount: "51" } })).status).toBe(403);
    expect((await post({ ...body, signerAddress: Keypair.random().publicKey() })).status).toBe(403);
    expect((await post(body, "http://another-site")).status).toBe(403);
    expect((await post({ ...body, approve: false })).status).toBe(403);
  });
  it("allows rejection by the active wallet and blocks subsequent reviews", async () => {
    const response = await post(signedBody(createRequest("parents", "5", "Medical"), false));
    const { data } = await response.json();
    expect(data.status).toBe("rejected");
    expect(data.approvals).toEqual([]);
    expect((await post(signedBody(data))).status).toBe(422);
  });
  it("resets old simulated reviews while preserving request details", () => {
    const original = createRequest("sister", "50", "School");
    expect(readRequests(JSON.stringify([{ ...original, approvals: ["jun", "parents"], status: "approved" }]))).toEqual([original]);
  });
  it("does not accept member labels as wallet approvals", () => {
    expect(() => decideRequest(createRequest("brother", "1", "Support"), "jun", true)).toThrow();
    expect(() => createRequest("jun", "1", "Support")).toThrow();
  });
  it.each(["0", "-1", "10000.0000001", "1e2", "0.00000001"])("rejects unsafe amount %s", amount => expect(() => emergencyAmount(amount)).toThrow());
  it("uses exact seven decimal arithmetic", () => expect(emergencyAmount("00050.0000001")).toBe("50.0000001"));
  it("does not restore a forged paid status", () => expect(() => readRequests(JSON.stringify([{ ...createRequest("sister", "1", "School"), status: "paid" }]))).toThrow());
  it("matches the SEP-53 published signature test vector", () => {
    expect(verifyWalletSignature("Hello, World!", "fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA==", "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L")).toBe(true);
  });
});

describe("emergency payment isolation", () => {
  const rows = [
    ["parents", "PARENT", "3f61d495-5bfa-4f51-b4e3-f666fc7bf22d"],
    ["brother", "BROTHER", "d34c35d4-10e0-4b59-9b98-425a1a503023"],
    ["sister", "SISTER", "73ebc55f-1a70-4ddd-8172-b05489871c85"],
  ] as const;
  it.each(rows)("maps %s exclusively to its deployment and remains disabled", (recipient, prefix, id) => {
    vi.stubEnv(`PAIFLOW_EMERGENCY_POT_${prefix}_DEPLOYMENT_ID`, id);
    vi.stubEnv(`PAIFLOW_EMERGENCY_POT_${prefix}_API_TOKEN`, `pfk_${"a".repeat(64)}`);
    vi.stubEnv("PAIFLOW_DEPLOYMENT_ID", "instant-split");
    expect(emergencyConfiguration(recipient).deploymentId).toBe(id);
    expect(emergencyIntegration(recipient)).toMatchObject({ deploymentId: id, paymentEnabled: false });
    expect(JSON.stringify(emergencyIntegration(recipient))).not.toContain(`pfk_${"a".repeat(64)}`);
    vi.stubEnv("PAIFLOW_DEPLOYMENT_ID", id);
    expect(() => emergencyConfiguration(recipient)).toThrow();
    vi.unstubAllEnvs();
  });
  it("refuses unsupported recipients and override queries", async () => {
    expect(() => emergencyConfiguration("jun")).toThrow();
    expect((await GET(new Request("http://localhost/api/emergency/integration?recipient=jun"))).status).toBe(422);
    expect((await GET(new Request("http://localhost/api/emergency/integration?deploymentId=split"))).status).toBe(422);
  });
  it("never prepares or submits regardless of forged approvals and repeated clicks", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    for (let i = 0; i < 2; i++) {
      const response = await POST(new Request("http://localhost/api/emergency/integration", { method: "POST", headers: { origin: "http://localhost" }, body: JSON.stringify({ approvals: 2, signedXdr: "forged", deploymentId: "split" }) }));
      expect(response.status).toBe(422);
    }
    expect(upstream).not.toHaveBeenCalled(); upstream.mockRestore();
    expect((await POST(new Request("http://localhost/api/emergency/integration", { method: "POST" }))).status).toBe(403);
  });
});

````

## tests/emergency-wallet.test.tsx

````tsx
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
vi.mock("@/lib/browser-api", () => ({ browserRequest: vi.fn() }));
vi.mock("@/lib/wallet", () => ({ connectWallet: vi.fn(), refreshWallet: vi.fn() }));
vi.mock("@stellar/freighter-api", () => ({ signMessage: vi.fn(), getNetworkDetails: vi.fn() }));
import { EmergencyPot } from "@/components/emergency-pot";
import { browserRequest } from "@/lib/browser-api";
import { connectWallet, refreshWallet } from "@/lib/wallet";
import { signMessage, getNetworkDetails } from "@stellar/freighter-api";
import { createRequest } from "@/lib/emergency";
const key = "padala-pabalik-emergency-v3";
const address = `G${"A".repeat(55)}`;
let tree: ReactTestRenderer;
let raw: string;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  raw = JSON.stringify([createRequest("brother", "50", "Medical")]);
  vi.stubGlobal("localStorage", { getItem: (name: string) => name === key ? raw : null, setItem: (_name: string, value: string) => { raw = value; } });
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, callback: () => Promise<void>) => callback() } });
  vi.stubGlobal("window", { location: { origin: "http://localhost" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.mocked(browserRequest).mockResolvedValue([]);
  vi.mocked(connectWallet).mockResolvedValue(address);
  vi.mocked(refreshWallet).mockResolvedValue(address);
  vi.mocked(getNetworkDetails).mockResolvedValue({ network: "TESTNET", networkUrl: "https://soroban-testnet.stellar.org", networkPassphrase: "Test SDF Network ; September 2015" });
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); });
async function clickApprove() {
  await act(async () => { tree = create(<EmergencyPot phpRate={null}/>); });
  const button = tree.root.findAllByType("button").find(item => item.children.includes("Approve with active wallet"));
  expect(button).toBeDefined();
  await act(async () => { button!.props.onClick(); });
}
it("keeps the request pending when Freighter rejects the message", async () => {
  vi.mocked(signMessage).mockResolvedValue({ signedMessage: null, signerAddress: "", error: { code: -1, message: "User rejected" } });
  await clickApprove();
  expect(JSON.parse(raw)[0].status).toBe("pending");
  expect(vi.mocked(browserRequest).mock.calls.some(([path]) => path === "/api/emergency/approval")).toBe(false);
});
it("refuses approval if the active wallet changes during signing", async () => {
  vi.mocked(signMessage).mockResolvedValue({ signedMessage: "a".repeat(86) + "==", signerAddress: address });
  vi.mocked(refreshWallet).mockResolvedValue(`G${"B".repeat(55)}`);
  await clickApprove();
  expect(JSON.parse(raw)[0].status).toBe("pending");
  expect(vi.mocked(browserRequest).mock.calls.some(([path]) => path === "/api/emergency/approval")).toBe(false);
});

````

## tests/emergency-payment.test.ts

````typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Account, Address, Contract, Keypair, Networks, TransactionBuilder, hash, nativeToScVal } from "@stellar/stellar-sdk";
vi.mock("server-only", () => ({}));
const upstream = vi.hoisted(() => ({ prepare: vi.fn(), submit: vi.fn(), status: vi.fn(), capabilities: vi.fn() }));
vi.mock("@/lib/paiflow", async original => ({ ...(await original<typeof import("@/lib/paiflow")>()), emergencyPaiflow: vi.fn(() => upstream) }));
vi.mock("@/lib/emergency-chain", async original => ({ ...(await original<typeof import("@/lib/emergency-chain")>()), verifyEmergencyTarget: vi.fn(), confirmedEmergencyPayment: vi.fn() }));
import { emergencyPayment } from "@/lib/emergency-payments";
import { EMERGENCY_TARGETS, confirmedEmergencyPayment, validateEmergencyEnvelope, verifyEmergencyTarget } from "@/lib/emergency-chain";
import { createRequest, decisionMessage, type EmergencyRequest, type EmergencyRecipient } from "@/lib/emergency";
import { PaiflowError } from "@/lib/paiflow";
const ids = { parents: "3f61d495-5bfa-4f51-b4e3-f666fc7bf22d", brother: "d34c35d4-10e0-4b59-9b98-425a1a503023", sister: "73ebc55f-1a70-4ddd-8172-b05489871c85" };
const payer = Keypair.random();
const origin = "http://localhost";
let directory: string;
let cwd: ReturnType<typeof vi.spyOn>;
function approved(recipient: EmergencyRecipient = "brother") {
  const request = createRequest(recipient, "50", "Medical bill");
  const signature = Buffer.from(payer.sign(hash(Buffer.from(`Stellar Signed Message:\n${decisionMessage(request, true, origin)}`)))).toString("base64");
  return { ...request, approvals: [payer.publicKey()], status: "approved", decision: { signerAddress: payer.publicKey(), signature, origin, approve: true } } as EmergencyRequest;
}
function prepared(recipient: EmergencyRecipient = "brother", amount = 500000000n) {
  const tx = new TransactionBuilder(new Account(payer.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET }).addOperation(new Contract(EMERGENCY_TARGETS[recipient].trigger).call("deposit", new Address(payer.publicKey()).toScVal(), nativeToScVal(amount, { type: "i128" }))).setTimeout(180).build();
  return { tx, response: { xdr: tx.toXDR(), network: "testnet" as const, networkPassphrase: Networks.TESTNET, expiresAt: new Date(Number(tx.timeBounds!.maxTime) * 1000).toISOString() } };
}
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), "emergency-payment-test-"));
  cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
  vi.stubEnv("PAIFLOW_MODE", "team");
  for (const [recipient, prefix] of [["parents", "PARENT"], ["brother", "BROTHER"], ["sister", "SISTER"]] as const) {
    vi.stubEnv(`PAIFLOW_EMERGENCY_POT_${prefix}_DEPLOYMENT_ID`, ids[recipient]);
    vi.stubEnv(`PAIFLOW_EMERGENCY_POT_${prefix}_API_TOKEN`, `pfk_${"a".repeat(64)}`);
  }
  vi.mocked(verifyEmergencyTarget).mockImplementation(async recipient => EMERGENCY_TARGETS[recipient]);
  upstream.capabilities.mockImplementation(async () => ({ deploymentId: ids.brother, network: "testnet", triggerType: "deposit", inputAsset: { kind: "known", symbol: "USDC" }, operations: { execute: { status: "supported" } } }));
  upstream.status.mockResolvedValue({ txHash: "", network: "testnet", status: "UNKNOWN" });
  vi.mocked(confirmedEmergencyPayment).mockResolvedValue({ status: "UNKNOWN" });
});
afterEach(async () => { cwd.mockRestore(); vi.unstubAllEnvs(); expect(path.dirname(path.resolve(directory))).toBe(path.resolve(tmpdir())); expect(path.basename(directory)).toMatch(/^emergency-payment-test-/); await rm(directory, { recursive: true, force: true }); });
describe("durable emergency payments", () => {
  it.each(["parents", "brother", "sister"] as const)("prepares %s once with its full approved amount", async recipient => {
    const request = approved(recipient);
    upstream.capabilities.mockResolvedValue({ deploymentId: ids[recipient], network: "testnet", triggerType: "deposit", inputAsset: { kind: "known", symbol: "USDC" }, operations: { execute: { status: "supported" } } });
    upstream.prepare.mockResolvedValue(prepared(recipient).response);
    const result = await emergencyPayment(request, origin, "prepare");
    expect(result).toMatchObject({ state: "prepared", wallet: EMERGENCY_TARGETS[recipient].wallet, deploymentId: ids[recipient], amount: "50" });
    expect(upstream.prepare).toHaveBeenCalledWith(payer.publicKey(), "500000000");
    expect(await emergencyPayment(request, origin, "prepare")).toEqual(result);
    expect(upstream.prepare).toHaveBeenCalledTimes(1);
  });
  it("persists the reservation before calling prepare and blocks an uncertain replacement", async () => {
    const request = approved();
    upstream.prepare.mockImplementation(async () => {
      const files = await readdir(path.join(directory, ".data/emergency-payments"));
      const file = files.find(name => name.endsWith(".json"))!;
      expect(JSON.parse(await readFile(path.join(directory, ".data/emergency-payments", file), "utf8")).state).toBe("reserved");
      throw new Error("Response lost");
    });
    await expect(emergencyPayment(request, origin, "prepare")).rejects.toThrow("unresolved");
    expect(await emergencyPayment(request, origin, "prepare")).toMatchObject({ state: "reserved" });
    expect(upstream.prepare).toHaveBeenCalledTimes(1);
  });
  it("allows a new preparation only after a definite insufficient-funds refusal", async () => {
    const request = approved();
    upstream.prepare.mockRejectedValueOnce(new PaiflowError(422, { code: "INSUFFICIENT_FUNDS", message: "Not enough funds" }, null, null)).mockResolvedValue(prepared().response);
    await expect(emergencyPayment(request, origin, "prepare")).rejects.toThrow("balance");
    expect(await emergencyPayment(request, origin, "prepare")).toMatchObject({ state: "prepared" });
  });
  it("rejects a split destination, wrong amount, and an unapproved request", async () => {
    expect(() => validateEmergencyEnvelope(prepared("parents").response.xdr, "brother", payer.publicKey(), "50")).toThrow();
    expect(() => validateEmergencyEnvelope(prepared("brother", 1n).response.xdr, "brother", payer.publicKey(), "50")).toThrow();
    await expect(emergencyPayment(createRequest("brother", "50", "Medical"), origin, "prepare")).rejects.toThrow();
    expect(upstream.prepare).not.toHaveBeenCalled();
  });
  it("locks request fields after preparation", async () => {
    const request = approved(); upstream.prepare.mockResolvedValue(prepared().response);
    await emergencyPayment(request, origin, "prepare");
    const changed = { ...request, amount: "51" };
    changed.decision = { ...request.decision!, signature: Buffer.from(payer.sign(hash(Buffer.from(`Stellar Signed Message:\n${decisionMessage(changed, true, origin)}`)))).toString("base64") };
    await expect(emergencyPayment(changed, origin, "prepare")).rejects.toThrow("immutable");
  });
  it("retains the exact envelope after lost submit and requires verified payout evidence for Paid", async () => {
    const request = approved(); const fixture = prepared(); upstream.prepare.mockResolvedValue(fixture.response);
    const original = await emergencyPayment(request, origin, "prepare");
    fixture.tx.sign(payer); const signedXdr = fixture.tx.toXDR();
    upstream.submit.mockRejectedValueOnce(new Error("Response lost")).mockResolvedValue({ txHash: original!.txHash, status: "SUCCESS" });
    expect(await emergencyPayment(request, origin, "submit", signedXdr)).toMatchObject({ state: "pending", signedXdr });
    upstream.status.mockResolvedValue({ txHash: original!.txHash, network: "testnet", status: "SUCCESS" });
    expect(await emergencyPayment(request, origin, "status")).toMatchObject({ state: "pending" });
    expect(await emergencyPayment(request, origin, "submit", signedXdr)).toMatchObject({ state: "pending" });
    expect(upstream.submit.mock.calls.every(([value]) => value === signedXdr)).toBe(true);
    vi.mocked(confirmedEmergencyPayment).mockResolvedValue({ status: "SUCCESS", ledger: 123 });
    expect(await emergencyPayment(request, origin, "status")).toMatchObject({ state: "paid", ledger: 123 });
    await emergencyPayment(request, origin, "submit", signedXdr);
    expect(upstream.submit).toHaveBeenCalledTimes(2);
  });
  it("records on-chain failure and prevents another payment for that request", async () => {
    const request = approved(); const fixture = prepared(); upstream.prepare.mockResolvedValue(fixture.response);
    const original = await emergencyPayment(request, origin, "prepare"); fixture.tx.sign(payer);
    upstream.status.mockResolvedValue({ txHash: original!.txHash, network: "testnet", status: "FAILED" });
    upstream.submit.mockResolvedValue({ txHash: original!.txHash, status: "FAILED" });
    vi.mocked(confirmedEmergencyPayment).mockResolvedValue({ status: "FAILED", ledger: 124 });
    expect(await emergencyPayment(request, origin, "submit", fixture.tx.toXDR())).toMatchObject({ state: "failed" });
    expect(await emergencyPayment(request, origin, "prepare")).toMatchObject({ state: "failed" });
    expect(upstream.prepare).toHaveBeenCalledTimes(1);
  });
  it("serializes simultaneous preparations across server calls", async () => {
    const request = approved();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    upstream.prepare.mockImplementation(async () => { entered(); await held; return prepared().response; });
    const first = emergencyPayment(request, origin, "prepare"); await enteredPromise;
    await expect(emergencyPayment(request, origin, "prepare")).rejects.toThrow("Another payment");
    release(); await first; expect(upstream.prepare).toHaveBeenCalledTimes(1);
  });
});

````

## tests/emergency-payment-ui.test.tsx

````tsx
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
vi.mock("@/lib/browser-api", () => ({ browserRequest: vi.fn() }));
vi.mock("@/lib/wallet", () => ({ connectWallet: vi.fn(), signPrepared: vi.fn() }));
import { EmergencyPaymentPanel } from "@/components/emergency-payment";
import { browserRequest } from "@/lib/browser-api";
import { connectWallet, signPrepared } from "@/lib/wallet";
import { createRequest, type EmergencyPayment, type EmergencyRequest } from "@/lib/emergency";
const wallet = `G${"A".repeat(55)}`;
let tree: ReactTestRenderer;
let record: EmergencyRequest;
let payment: EmergencyPayment;
const storage = new Map<string, string>();
beforeEach(() => {
  vi.clearAllMocks(); storage.clear();
  record = { ...createRequest("brother", "50", "Medical"), status: "approved", approvals: [wallet], decision: { signerAddress: wallet, signature: "a".repeat(86) + "==", approve: true, origin: "http://localhost" } };
  payment = { state: "prepared", requestId: record.id, deploymentId: "d34c35d4-10e0-4b59-9b98-425a1a503023", wallet: `G${"B".repeat(55)}`, payer: wallet, amount: "50", txHash: "a".repeat(64), prepared: { xdr: "original-preparation", network: "testnet", networkPassphrase: "Test SDF Network ; September 2015", expiresAt: new Date(Date.now() + 180000).toISOString(), txHash: "a".repeat(64) }, message: "Ready" };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, callback: () => Promise<void>) => callback() } });
  vi.mocked(connectWallet).mockResolvedValue(wallet);
  vi.mocked(signPrepared).mockResolvedValue("original-signed-envelope");
  vi.mocked(browserRequest).mockImplementation(async (_path, body) => {
    const phase = (body as { phase: string }).phase;
    return (phase === "status" ? null : phase === "prepare" ? payment : { ...payment, state: "paid", ledger: 123, message: "Confirmed" }) as never;
  });
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); });
async function render() {
  await act(async () => { tree = create(<EmergencyPaymentPanel request={record} integration={{ recipient: "brother", configured: true, paymentEnabled: true, deploymentId: payment.deploymentId, message: "Verified" }} expanded onReview={() => {}} onClose={() => {}}/>); });
}
function sendButton() { return tree.root.findAllByType("button").find(button => String(button.children.join(" ")).includes("Funds") || String(button.children.join(" ")).includes("Original Transaction"))!; }
it("preserves the original preparation and never submits after Freighter cancellation", async () => {
  vi.mocked(signPrepared).mockImplementation(async () => {
    expect(JSON.parse(storage.get(`padala-pabalik:emergency-payment:v1:${record.id}`)!).txHash).toBe(payment.txHash);
    throw new Error("User rejected");
  });
  await render(); expect(sendButton().props.disabled).toBe(false);
  await act(async () => { sendButton().props.onClick(); });
  expect(vi.mocked(browserRequest).mock.calls.some(([, body]) => (body as { phase: string }).phase === "submit")).toBe(false);
  expect(JSON.parse(storage.get(`padala-pabalik:emergency-payment:v1:${record.id}`)!).txHash).toBe(payment.txHash);
});
it("resumes only the locally saved original envelope when submit never reached the server", async () => {
  storage.set(`padala-pabalik:emergency-payment:v1:${record.id}`, JSON.stringify({ ...payment, signedXdr: "original-signed-envelope" }));
  vi.mocked(browserRequest).mockImplementation(async (_path, body) => (body as { phase: string }).phase === "status" ? payment as never : { ...payment, state: "paid", ledger: 123, message: "Confirmed" } as never);
  await render(); await act(async () => { sendButton().props.onClick(); });
  expect(signPrepared).not.toHaveBeenCalled();
  expect(vi.mocked(browserRequest).mock.calls.some(([, body]) => (body as { phase: string }).phase === "prepare")).toBe(false);
  expect(vi.mocked(browserRequest).mock.calls.find(([, body]) => (body as { phase: string }).phase === "submit")![1]).toMatchObject({ signedXdr: "original-signed-envelope" });
});
it("refuses a different active wallet before payment preparation", async () => {
  vi.mocked(connectWallet).mockResolvedValue(`G${"C".repeat(55)}`);
  await render(); await act(async () => { sendButton().props.onClick(); });
  expect(signPrepared).not.toHaveBeenCalled();
  expect(vi.mocked(browserRequest).mock.calls.some(([, body]) => (body as { phase: string }).phase !== "status")).toBe(false);
});
it("blocks a replacement if local payment evidence exists but the server record is missing", async () => {
  storage.set(`padala-pabalik:emergency-payment:v1:${record.id}`, JSON.stringify({ ...payment, signedXdr: "original-signed-envelope" }));
  await render(); expect(sendButton().props.disabled).toBe(true);
});
it("serializes duplicate send clicks and retains the signature before submission", async () => {
  vi.mocked(browserRequest).mockImplementation(async (_path, body) => {
    const phase = (body as { phase: string }).phase;
    if (phase === "submit") {
      expect(JSON.parse(storage.get(`padala-pabalik:emergency-payment:v1:${record.id}`)!).signedXdr).toBe("original-signed-envelope");
      return { ...payment, state: "paid", ledger: 123, message: "Confirmed" } as never;
    }
    return (phase === "prepare" ? payment : null) as never;
  });
  await render(); const button = sendButton();
  await act(async () => { button.props.onClick(); button.props.onClick(); });
  expect(signPrepared).toHaveBeenCalledTimes(1);
  expect(vi.mocked(browserRequest).mock.calls.filter(([, body]) => (body as { phase: string }).phase === "prepare")).toHaveLength(1);
  expect(vi.mocked(browserRequest).mock.calls.filter(([, body]) => (body as { phase: string }).phase === "submit")).toHaveLength(1);
});

````

## tests/emergency-chain.test.ts

````typescript
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { EMERGENCY_TARGETS, EMERGENCY_USDC, payoutEventsMatch } from "@/lib/emergency-chain";
const payer = Keypair.random().publicKey();
function event(from: string, to: string, amount = 500000000n, token = EMERGENCY_USDC) {
  const contract = new Address(token).toScAddress();
  if (contract.type !== "scAddressTypeContract") throw new Error("Expected contract.");
  return new xdr.ContractEvent({ ext: xdr.ExtensionPoint.v0(), contractId: contract.contractId, type: xdr.ContractEventType.contract, body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics: [nativeToScVal("transfer", { type: "symbol" }), new Address(from).toScVal(), new Address(to).toScVal(), nativeToScVal("USDC")], data: nativeToScVal(amount, { type: "i128" }) })) });
}
it.each(["parents", "brother", "sister"] as const)("confirms only the exact %s transfer chain", recipient => {
  const target = EMERGENCY_TARGETS[recipient];
  const events = [event(payer, target.trigger), event(target.trigger, target.pay), event(target.pay, target.wallet)];
  expect(payoutEventsMatch(events, recipient, payer, "50")).toBe(true);
  expect(payoutEventsMatch(events.slice(0, 2), recipient, payer, "50")).toBe(false);
  expect(payoutEventsMatch(events, recipient, payer, "51")).toBe(false);
  const other = Keypair.random().publicKey();
  expect(payoutEventsMatch([...events, event(target.pay, other, 1n)], recipient, payer, "50")).toBe(false);
  expect(payoutEventsMatch([...events.slice(0, 2), event(target.pay, other)], recipient, payer, "50")).toBe(false);
});

````

## tests/emergency-client.test.ts

````typescript
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { emergencyPaiflow } from "@/lib/paiflow";
const tuples = [
  ["parents", "PARENT", "3f61d495-5bfa-4f51-b4e3-f666fc7bf22d", "a"],
  ["brother", "BROTHER", "d34c35d4-10e0-4b59-9b98-425a1a503023", "b"],
  ["sister", "SISTER", "73ebc55f-1a70-4ddd-8172-b05489871c85", "c"],
] as const;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it.each(tuples)("uses only %s deployment credentials without needing Instant credentials", async (recipient, prefix, id, character) => {
  vi.stubEnv("PAIFLOW_MODE", "team"); vi.stubEnv("PAIFLOW_BASE_URL", "https://platform.test");
  vi.stubEnv("PAIFLOW_API_TOKEN", ""); vi.stubEnv("PAIFLOW_DEPLOYMENT_ID", "instant-split");
  const token = `pfk_${character.repeat(64)}`;
  vi.stubEnv(`PAIFLOW_EMERGENCY_POT_${prefix}_DEPLOYMENT_ID`, id);
  vi.stubEnv(`PAIFLOW_EMERGENCY_POT_${prefix}_API_TOKEN`, token);
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: { status: "PENDING" } })));
  vi.stubGlobal("fetch", fetch);
  const api = emergencyPaiflow(recipient);
  await api.capabilities(); await api.prepare("payer", "500000000"); await api.submit("original-signed-envelope"); await api.status("a".repeat(64));
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls.every(([url, options]) => String(url).startsWith(`https://platform.test/api/v1/deployments/${id}/`) && options.headers.Authorization === `Bearer ${token}`)).toBe(true);
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ from: "payer", amount: "500000000" });
  expect(String(fetch.mock.calls[2]![0])).toContain("execute/submit?wait=false");
});
it("refuses emergency API calls in preparation or shared demo mode", () => {
  vi.stubEnv("PAIFLOW_MODE", "demo"); expect(() => emergencyPaiflow("brother")).toThrow();
  vi.stubEnv("PAIFLOW_MODE", "prepare"); expect(() => emergencyPaiflow("brother")).toThrow();
});

````

## tests/page.test.ts

````typescript
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/wallet", () => ({}));
const token = `pfk_${"a".repeat(64)}`;
const deployment = "11111111-1111-4111-8111-111111111111";
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv("PAIFLOW_MODE", "team");
  vi.stubEnv("PAIFLOW_API_TOKEN", token);
  vi.stubEnv("PAIFLOW_DEPLOYMENT_ID", deployment);
  vi.stubEnv("PAIFLOW_BASE_URL", "http://localhost:3000");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function screen() {
  const { default: Page } = await import("@/app/page");
  return renderToStaticMarkup(await Page());
}
it("keeps the family overview as the default without server-side upstream calls", async () => {
  const html = await screen();
  expect(html).toContain("Family allocations");
  expect(html).toContain("Open Emergency Pot");
  expect(html).toContain("Send Padala");
  expect(html).not.toContain("Per-payment recipient");
  expect(html).not.toContain(token);
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each(["prepare", "demo", "invalid"])("server render preserves %s guards and performs no upstream calls", async mode => {
  vi.stubEnv("PAIFLOW_MODE", mode);
  const html = await screen();
  expect(html).not.toContain("Per-payment recipient");
  expect(html).not.toContain(token);
  expect(fetchMock).not.toHaveBeenCalled();
  if (mode === "prepare") {
    expect(html).toContain("Preparation mode");
    expect(html).toContain("wallet actions are unavailable");
  }
  if (mode === "invalid") expect(html).toContain("Payments unavailable");
});

````

## scripts/verify-emergency-contracts.mjs

````javascript
import { rpc, xdr, Address, Asset, Networks, scValToNative } from '@stellar/stellar-sdk';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Read-only verification: no keys, API tokens, simulation, signing or submission.
const server = new rpc.Server('https://soroban-testnet.stellar.org');
const expectedAsset = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5').contractId(Networks.TESTNET);
const recipients = [
  { recipient: 'parents', deploymentId: '3f61d495-5bfa-4f51-b4e3-f666fc7bf22d', trigger: 'CA4D6A6TV53ESGHWEXV5VMSFGFV4SXSELTDUSYJIA47RU4NNDHGW3INV', wallet: 'GBRHKU2LZNDPRCVXXPFZZ3XNS5DEWGTA4AVCPDER2RHY56EKOQ2EWMJK' },
  { recipient: 'brother', deploymentId: 'd34c35d4-10e0-4b59-9b98-425a1a503023', trigger: 'CDL2M5WIGG7HFH2BFL4XZOWHN3WK7BRYZCH5YFT2N3FBFDE2IJKRW7C4', wallet: 'GAWW3W5X5YETABCWRA4NBIOTX46YGFO5H3NEUHQCORW7PCE7ZYUAPLNB' },
  { recipient: 'sister', deploymentId: '73ebc55f-1a70-4ddd-8172-b05489871c85', trigger: 'CCQIVWQOVORC57J2PPZZ54NECNYKLH76UWSTM5DOGO4GBLEPJ3IM7OS6', wallet: 'GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX' },
];
async function read(contract) {
  const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(contract).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent }));
  const response = await server.getLedgerEntries(key);
  assert.equal(response.entries.length, 1, 'Contract storage unavailable');
  const instance = response.entries[0].val.contractData.val.instance;
  const fields = {};
  for (const item of instance.storage ?? []) {
    const [name] = scValToNative(item.key);
    fields[name] = scValToNative(item.val);
  }
  return { contract, ledger: response.latestLedger, fields };
}
const checks = [];
for (const target of recipients) {
  // Bind the supplied/discovered trigger to the public deployment trigger page.
  const response = await fetch(`https://beta.app.paiflow.xyz/trigger/${target.deploymentId}`);
  assert(response.ok, 'Public trigger page unavailable');
  const html = await response.text();
  const addresses = [...new Set(html.match(/C[A-Z2-7]{55}/g) ?? [])];
  assert.deepEqual(addresses, [target.trigger], 'Trigger page contract association changed');
  const trigger = await read(target.trigger);
  assert.equal(trigger.fields.Asset, expectedAsset, 'Incorrect trigger asset');
  assert.equal(trigger.fields.Version, 1, 'Unexpected trigger version');
  assert.equal(trigger.fields.NextSteps.length, 1, 'Expected one downstream contract');
  const pay = await read(trigger.fields.NextSteps[0].address);
  assert.equal(pay.fields.Recipient, target.wallet, 'Recipient mismatch');
  assert.equal(pay.fields.Asset, expectedAsset, 'Incorrect Pay asset');
  assert.equal(pay.fields.Amount, 0n, 'Fixed amount must be zero');
  assert.equal(pay.fields.PercentageBps, 10000, 'Must pay 100%');
  assert.equal(pay.fields.ParentNode, target.trigger, 'Pay parent mismatch');
  assert.equal(pay.fields.IsCashOut, false, 'Unexpected cash-out operation');
  assert.deepEqual(pay.fields.NextSteps, [], 'Unexpected downstream payment steps');
  assert.equal(pay.fields.Version, 4, 'Unexpected Pay version');
  checks.push({ ...target, triggerState: trigger, payState: pay, configurationMatches: true });
  console.log(`${target.recipient}: configured recipient, 100% amount, exact Testnet USDC and single downstream Pay verified`);
}
const report = { checkedAt: new Date().toISOString(), network: 'testnet', rpc: 'https://soroban-testnet.stellar.org', expectedAsset, checks, limitation: 'Read-only configuration evidence at the recorded ledgers. No payment sent, no bytecode audit or successful payout proof. Recheck before preparing any future payment.' };
await writeFile(new URL('../docs/emergency-onchain-verification.json', import.meta.url), JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');

````

## docs/emergency-onchain-verification.json

````json
{
  "checkedAt": "2026-10-14T04:40:01.167Z",
  "network": "testnet",
  "rpc": "https://soroban-testnet.stellar.org",
  "expectedAsset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "checks": [
    {
      "recipient": "parents",
      "deploymentId": "3f61d495-5bfa-4f51-b4e3-f666fc7bf22d",
      "trigger": "CA4D6A6TV53ESGHWEXV5VMSFGFV4SXSELTDUSYJIA47RU4NNDHGW3INV",
      "wallet": "GBRHKU2LZNDPRCVXXPFZZ3XNS5DEWGTA4AVCPDER2RHY56EKOQ2EWMJK",
      "triggerState": {
        "contract": "CA4D6A6TV53ESGHWEXV5VMSFGFV4SXSELTDUSYJIA47RU4NNDHGW3INV",
        "ledger": 5185842,
        "fields": {
          "Admin": "GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX",
          "Asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          "NextSteps": [
            {
              "address": "CDWHILTEQ5KMONWZ3XQML3ISFBLSYMF65GRYPQT2T67BU32QBKBJJXKO",
              "data": ""
            }
          ],
          "Version": 1
        }
      },
      "payState": {
        "contract": "CDWHILTEQ5KMONWZ3XQML3ISFBLSYMF65GRYPQT2T67BU32QBKBJJXKO",
        "ledger": 5185842,
        "fields": {
          "Admin": "GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX",
          "Amount": "0",
          "Asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          "IsCashOut": false,
          "NextSteps": [],
          "ParentNode": "CA4D6A6TV53ESGHWEXV5VMSFGFV4SXSELTDUSYJIA47RU4NNDHGW3INV",
          "PercentageBps": 10000,
          "Recipient": "GBRHKU2LZNDPRCVXXPFZZ3XNS5DEWGTA4AVCPDER2RHY56EKOQ2EWMJK",
          "Version": 4
        }
      },
      "configurationMatches": true
    },
    {
      "recipient": "brother",
      "deploymentId": "d34c35d4-10e0-4b59-9b98-425a1a503023",
      "trigger": "CDL2M5WIGG7HFH2BFL4XZOWHN3WK7BRYZCH5YFT2N3FBFDE2IJKRW7C4",
      "wallet": "GAWW3W5X5YETABCWRA4NBIOTX46YGFO5H3NEUHQCORW7PCE7ZYUAPLNB",
      "triggerState": {
        "contract": "CDL2M5WIGG7HFH2BFL4XZOWHN3WK7BRYZCH5YFT2N3FBFDE2IJKRW7C4",
        "ledger": 5185842,
        "fields": {
          "Admin": "GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX",
          "Asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          "NextSteps": [
            {
              "address": "CA6NKUJGJG4YQEVPN6NTXXEN7MO42L5OA4A2JVCYNOMMGFP66G2EIS2H",
              "data": ""
            }
          ],
          "Version": 1
        }
      },
      "payState": {
        "contract": "CA6NKUJGJG4YQEVPN6NTXXEN7MO42L5OA4A2JVCYNOMMGFP66G2EIS2H",
        "ledger": 5185842,
        "fields": {
          "Admin": "GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX",
          "Amount": "0",
          "Asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          "IsCashOut": false,
          "NextSteps": [],
          "ParentNode": "CDL2M5WIGG7HFH2BFL4XZOWHN3WK7BRYZCH5YFT2N3FBFDE2IJKRW7C4",
          "PercentageBps": 10000,
          "Recipient": "GAWW3W5X5YETABCWRA4NBIOTX46YGFO5H3NEUHQCORW7PCE7ZYUAPLNB",
          "Version": 4
        }
      },
      "configurationMatches": true
    },
    {
      "recipient": "sister",
      "deploymentId": "73ebc55f-1a70-4ddd-8172-b05489871c85",
      "trigger": "CCQIVWQOVORC57J2PPZZ54NECNYKLH76UWSTM5DOGO4GBLEPJ3IM7OS6",
      "wallet": "GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX",
      "triggerState": {
        "contract": "CCQIVWQOVORC57J2PPZZ54NECNYKLH76UWSTM5DOGO4GBLEPJ3IM7OS6",
        "ledger": 5185842,
        "fields": {
          "Admin": "GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX",
          "Asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          "NextSteps": [
            {
              "address": "CDHOU6GFDTFIBADEKF4FEKSGZOT2HTLKMOH5OTYK2SROCH73VN5FKXGE",
              "data": ""
            }
          ],
          "Version": 1
        }
      },
      "payState": {
        "contract": "CDHOU6GFDTFIBADEKF4FEKSGZOT2HTLKMOH5OTYK2SROCH73VN5FKXGE",
        "ledger": 5185842,
        "fields": {
          "Admin": "GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX",
          "Amount": "0",
          "Asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          "IsCashOut": false,
          "NextSteps": [],
          "ParentNode": "CCQIVWQOVORC57J2PPZZ54NECNYKLH76UWSTM5DOGO4GBLEPJ3IM7OS6",
          "PercentageBps": 10000,
          "Recipient": "GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX",
          "Version": 4
        }
      },
      "configurationMatches": true
    }
  ],
  "limitation": "Read-only configuration evidence at the recorded ledgers. No payment sent, no bytecode audit or successful payout proof. Recheck before preparing any future payment."
}

````

## docs/emergency-pot.md

````markdown
# Emergency Pot: requests, approval and payments

## Local workflow

Use the project's Node 22 runtime and `pnpm.cmd dev`. Refresh the browser after updating the application. Open Emergency Pot and choose Parents, Brother or Younger Sister. Submit the amount and reason. Connect the active Freighter wallet on Testnet and approve the request with its message signature. Exactly one wallet approval is required; Jun is not required.

Open **Review emergency payment**. Check the recipient name, exact USDC amount, recipient public address, deployment ID and paying wallet. Click **Send Emergency Funds**, then review and authorize the transaction in Freighter. The paying wallet must be the same wallet that signed the request approval. Its Testnet USDC balance covers the requested amount, and its XLM balance covers transaction fees. This is a payment from that wallet, not a withdrawal from a shared emergency reserve.

The UI shows Payment Pending while submission/confirmation is unresolved. It marks Paid only after Stellar RPC confirms success and the exact USDC transfers to the selected recipient. A confirmed payment includes a Testnet explorer link and ledger. Approval alone or an HTTP 200 response cannot mark it Paid. Start manual testing with an amount that fits the payer's balance.

## Approval and authorization

Any active wallet may approve or reject, including a recipient wallet. There is no simulated reviewer selector or second reviewer. The SEP-53 message binds the decision to this site's origin, Testnet, request ID, requester, amount, reason and creation time. `/api/emergency/approval` verifies its signature; saved approval evidence is reverified on load and cross-tab updates. Payment preparation, status and submission independently reverify that same signature.

Old v3 simulated reviews reset to Pending while retaining request details. v2 records remain untouched because they lack requester evidence. Request history is browser-local, not a shared family database. The server durably stores the signed request and immutable payment attempt when preparing its payment. The wallet approval is authorization under the requested any-active-wallet policy; no browser status alone is trusted to move funds.

## Deployment routing

| Recipient | Deployment ID | Wallet |
| --- | --- | --- |
| Parents | 3f61d495-5bfa-4f51-b4e3-f666fc7bf22d | GBRHKU2LZNDPRCVXXPFZZ3XNS5DEWGTA4AVCPDER2RHY56EKOQ2EWMJK |
| Brother | d34c35d4-10e0-4b59-9b98-425a1a503023 | GAWW3W5X5YETABCWRA4NBIOTX46YGFO5H3NEUHQCORW7PCE7ZYUAPLNB |
| Sister | 73ebc55f-1a70-4ddd-8172-b05489871c85 | GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX |

The backend maps the signed requester to server-only credentials and verified contract addresses. Client deployment IDs, payer overrides, recipient addresses and arbitrary upstream paths are not accepted. Jun cannot be an emergency requester. No emergency operation calls Instant Padala's `/api/pay` or global deployment helpers. Instant and Scheduled implementations, family budgets, exchange rates and existing wallet recovery remain intact.

`lib/paiflow.ts` owns every Paiflow API call. Its dedicated emergency client uses only that recipient's configuration and refuses prepare/demo mode. It does not require or fall back to Instant credentials. Deposit preparation uses the documented recipient-specific `execute` endpoint, followed by wallet signing and that deployment's `execute/submit` endpoint. A deployment UUID is not a funding destination, and plain token transfers are not substituted for deposit execution.

Before preparation, live capabilities must match the expected deployment, Testnet, deposit trigger and USDC input. Both deployed contract instances are read from Stellar RPC: pinned bytecode, exact USDC asset, one downstream Pay, intended recipient, 100% payout, zero fixed amount, correct parent and no further steps. Those configuration checks run again before submission.

Prepared XDR must contain one deposit call to the verified trigger, the approved payer and exact amount, no memo or extra operations, bounded fees and expiry, Testnet passphrase and source-account authorization only. The signed envelope must retain the exact transaction hash and contain the payer's valid signature. The UI requires explicit Freighter authorization; approval never starts a payment automatically.

## Confirmation and recovery

Paiflow submission is idempotent by original envelope hash. The app preserves its original signed XDR and never silently creates a second transaction after PENDING, UNKNOWN, timeout, missing history or expired preparation.

The server checks the deployment-specific transaction endpoint and independently queries Stellar RPC. Paid requires a successful original transaction, matching deposit envelope/hash, and exactly these transfers of the full approved USDC amount: payer -> trigger -> Pay -> intended wallet. Missing payout evidence, extra USDC recipients, RPC errors or pruned history remain uncertain. RPC-confirmed failure becomes Failed. Terminal Paid and Failed attempts cannot start another payment for the same request.

After an explicit preparation refusal, such as insufficient funds, a retry may prepare an original transaction because no envelope was issued. After wallet cancellation, **Sign Original Transaction** reuses the stored preparation if it is still valid. **Resubmit Original Transaction** sends only the previously saved signature/envelope. Expired or lost preparations are not replaced without finality evidence; unresolved reservations require operator recovery. Automatic polling confirms status and never signs or sends funds.

## Durable local storage

Payment attempts are stored under `.data/emergency-payments/` in the server's working directory. Request identity is scoped to the browser origin. Exclusive file locks serialize processes, and atomic writes with file sync save the reservation before preparation and exact signed envelope before submission. Immutable recipient, amount, payer and deployment bindings are enforced on every operation. Browser Web Locks serialize tabs, and storage failures stop signing/submission. If local evidence exists but the server record is missing, a replacement is blocked.

**Keep `.data` intact across local server restarts and backups.** It is gitignored and must not be committed or logged. This implementation requires a persistent filesystem shared by the local Node server. An ephemeral/serverless host or independently stored multiple instances requires a shared durable database/transactional lock implementation before deployment. A crash with a held file lock can require operator review; locks never expire automatically. Do not delete payment records to retry uncertain funds.

## Environment and amounts

No new credentials or environment variables are needed. Keep `PAIFLOW_MODE=team`, `PAIFLOW_BASE_URL` and these six assignments in `.env.local`, never NEXT_PUBLIC variables:

| Recipient | Deployment variable | Token variable |
| --- | --- | --- |
| Parents | PAIFLOW_EMERGENCY_POT_PARENT_DEPLOYMENT_ID | PAIFLOW_EMERGENCY_POT_PARENT_API_TOKEN |
| Brother | PAIFLOW_EMERGENCY_POT_BROTHER_DEPLOYMENT_ID | PAIFLOW_EMERGENCY_POT_BROTHER_API_TOKEN |
| Sister | PAIFLOW_EMERGENCY_POT_SISTER_DEPLOYMENT_ID | PAIFLOW_EMERGENCY_POT_SISTER_API_TOKEN |

IDs are checked against the table above and cannot collide with Instant Padala. Tokens never enter public configuration or errors. `.env.local` was not modified. `lib/amount.ts` uses bigint conversion at seven decimal places with a maximum request of 10,000 USDC. PHP estimates use the existing fetched rate only for display.

## Acceptance checklist

- [x] All three requesters, exact amount validation, UUID/time/reason history.
- [x] One active-wallet approval, signature validation and signed rejection.
- [x] Parents' updated deployment mapping and live verification of all three routes.
- [x] Dedicated confirmation, Freighter payment signing and deployment-specific submit.
- [x] Server reservation, immutable attempts, duplicate-click protection and original-XDR recovery.
- [x] Payment Pending, Paid and Failed from server evidence, with explorer/ledger details.
- [x] Independent exact-recipient/amount payout confirmation; API success alone is insufficient.
- [x] Automated cancellation, insufficient-funds refusal, changed wallet, concurrency and uncertain-response coverage.
- [x] Existing regression suite, TypeScript, isolated production build and browser token scan.
- [ ] UNVERIFIED: live Freighter signing and actual transfers to the three recipients, including unrelated-wallet balance checks. No funds were sent during implementation.
- [ ] UNVERIFIED: manual live Instant and Scheduled wallet regression. Existing automated checks pass.
- [ ] OUT OF SCOPE: shared family request database and hosting on ephemeral/distributed infrastructure.

Run `pnpm.cmd exec tsc --noEmit`, `pnpm.cmd build`, then `pnpm.cmd test`. Stop a dev server first or build an isolated source copy to avoid sharing `.next`. Test workers are capped at four to prevent resource-contention timeouts during SDK imports.

[Public Paiflow OpenAPI](https://beta.app.paiflow.xyz/api/v1/openapi.json), [Freighter signing](https://docs.freighter.app/extension-freighter-api/signing), and [SEP-53](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md) document the API/signing contracts. `docs/emergency-onchain-verification.json` records the original read-only contract evidence. See `docs/emergency-pot-validation.md` for results and `docs/emergency-pot-file-contents.md` for complete delivered sources.

````

## docs/emergency-pot-validation.md

````markdown
# Emergency payments validation ? 2026-10-14

- PASS: `pnpm.cmd exec tsc --noEmit` on final implementation.
- PASS: `pnpm.cmd test` ? 16 files, 192 tests, zero failures.
- PASS: production build in an isolated temporary source copy, using existing installed dependencies. The running dev server was not stopped; `.env.local` was not copied.
- PASS: isolated browser bundle scan ? 28 files, no Paiflow API token matches.
- PASS: read-only GET `http://localhost:3000/api/emergency/integration` ? all three configured deployments returned paymentEnabled=true after actual Paiflow capabilities and live pinned contract verification. No prepare or submit was called.
- PASS: read-only Stellar RPC check of an existing public Testnet USDC transaction confirmed the successful-transaction response exposes committed contractEventsXdr used by the payout verifier. This was not an emergency payment test.

New tests cover each recipient's own credentials/UUID independently of Instant configuration; exact amount/deposit binding; extra-recipient/missing/wrong-amount payout events; same-origin and verified wallet approval; immutable request fields; concurrent server preparation; reservation durability before upstream calls; uncertain preparation/submission; original signed envelope retention/resubmission; confirmed Paid/Failed terminal states; insufficient-funds refusal; wallet cancellation/change; duplicate UI clicks; and missing durable server evidence.

An unrestricted parallel regression run hit an existing page test's five-second cold-import deadline under SDK worker contention. Vitest now caps workers at four; the full standard test command passes without weakening assertions or increasing timeouts.

The available runtime is Node 24.21.0, while the declared project engine is Node 22. Use Node 22 locally to match the project requirement.

No wallet was opened or signed by the agent, and no funds were sent. Actual Freighter authorizations and live recipient payouts remain manual acceptance work. Durable payment storage is local `.data/emergency-payments`, not a production shared database; preserve it across restarts and do not use an ephemeral host.

````
