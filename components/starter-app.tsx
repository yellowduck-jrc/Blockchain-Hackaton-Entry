"use client";

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
type RequestStatus = "pending" | "approved" | "declined";
type EmergencyRequest = { id: string; amount: string; reason: string; status: RequestStatus; approvals: number; createdAt: string };
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
const EMERGENCY_KEY = "padala-pabalik-emergency-v2";
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
    home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M9 21v-8h6v8" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
    heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z" />,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    wallet: <><rect x="2" y="5" width="20" height="15" rx="3" /><path d="M16 13h6M5 5V3h14" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5M5 9a7 7 0 0 1 12-3l3 1M19 15a7 7 0 0 1-12 3l-3-1" /></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    plus: <path d="M12 5v14M5 12h14" />,
    external: <><path d="M14 3h7v7M10 14 21 3M21 13v7H4V3h7" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.home}</svg>;
}
function Avatar({ initials, large = false }: { initials: string; large?: boolean }) {
  return <span className={`pp-avatar ${large ? "pp-avatar-large" : ""}`}>{initials}</span>;
}
function AllocationBar({ shares }: { shares: Shares }) {
  return <div className="pp-allocation-bar" aria-label="Family budget allocation percentages">{MEMBERS.map(member => <div key={member.id} style={{ width: `${shares[member.id]}%`, background: member.color }} title={`${member.name}: ${shares[member.id]}%`} />)}</div>;
}
function AllocationCard({ member, shares, allowance, onClick }: { member: Member; shares: Shares; allowance: number; onClick?: () => void }) {
  return <div className="pp-allocation-card"><div className="pp-allocation-person"><Avatar initials={member.initials} /><div><strong>{member.name}</strong><p>{member.purpose} · &quot;{member.note}&quot;</p></div></div><div className="pp-allocation-end"><strong>{money(allocation(allowance, shares[member.id]))}</strong><span>{shares[member.id]}%</span>{onClick && <button type="button" className="pp-text-button" onClick={onClick}>View</button>}</div></div>;
}

export function StarterApp({ config, payoutsAvailable: _payoutsAvailable = false }: { config: PublicConfig; payoutsAvailable?: boolean }) {
  const enabled = config.mode === "demo" || config.mode === "team";
  const configIdentity = JSON.stringify(config);
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
  const [requests, setRequests] = useState<EmergencyRequest[]>([]);
  const [requestAmount, setRequestAmount] = useState("100");
  const [requestReason, setRequestReason] = useState("");
  const [suggestionStatus, setSuggestionStatus] = useState<"pending" | "approved" | "declined">("pending");

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
      const savedRequests = localStorage.getItem(EMERGENCY_KEY);
      if (savedRequests) {
        const data: unknown = JSON.parse(savedRequests);
        if (Array.isArray(data)) setRequests(data.filter(item => isObject(item) && typeof item.id === "string" && typeof item.amount === "string" && typeof item.reason === "string" && (item.status === "pending" || item.status === "approved" || item.status === "declined") && typeof item.approvals === "number" && typeof item.createdAt === "string") as EmergencyRequest[]);
      }
    } catch { /* Invalid or unavailable browser storage: keep defaults. */ }
    setHydrated(true);
  }, []);
  useEffect(() => { if (hydrated && validShares && decimal(allowance) !== null) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ allowance, shares })); } catch { } } }, [allowance, shares, hydrated, validShares]);
  useEffect(() => { if (hydrated) { try { localStorage.setItem(EMERGENCY_KEY, JSON.stringify(requests)); } catch { } } }, [requests, hydrated]);

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
  function createEmergencyRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requested = decimal(requestAmount);
    if (requested === null || requested <= 0 || !requestReason.trim()) { setError("Enter a valid emergency amount and reason."); return; }
    const request: EmergencyRequest = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, amount: requestAmount, reason: requestReason.trim(), status: "pending", approvals: 1, createdAt: new Date().toISOString() };
    setRequests(prev => [request, ...prev]);
    setRequestReason("");
    setError("");
    setNotice("Emergency request saved locally. One more demo approval is required. No payment has been made.");
  }
  function decideRequest(id: string, approve: boolean) {
    setRequests(prev => prev.map(request => request.id === id && request.status === "pending" ? { ...request, status: approve ? "approved" : "declined", approvals: approve ? 2 : 1 } : request));
    setNotice(approve ? "Request approved in the demo. Payment to Parents is NOT sent automatically; a separately authorized transfer is required." : "Request declined. No funds were transferred.");
  }

  const approvedRequests = useMemo(() => requests.filter(request => request.status === "approved"), [requests]);

  return <div className="pp-app">
    <aside className={`pp-sidebar ${mobileMenuOpen ? "pp-sidebar-open" : ""}`}>
      <div className="pp-brand"><div className="pp-brand-icon"><Icon name="home" size={25} /><span>♥</span></div><div><div className="pp-brand-name">Padala <span>Pabalik</span></div><p>Padala na may malasakit</p></div></div>
      <div className="pp-sidebar-label">YOUR WORKSPACE</div>
      <nav className="pp-navigation">{NAVIGATION.map(item => <button key={item.id} type="button" className={`pp-nav-item ${page === item.id ? "pp-nav-active" : ""}`} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav>
      <div className="pp-sidebar-bottom"><div className="pp-sidebar-help"><Icon name="shield" size={23} /><div><strong>Powered by Stellar</strong><p>Transparent family support through Paiflow.</p></div></div><div className="pp-sidebar-profile"><Avatar initials="JN" /><div><strong>Jun</strong><p>Breadwinner · Provider</p></div></div></div>
    </aside>
    {mobileMenuOpen && <button type="button" className="pp-mobile-overlay" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)} />}
    <div className="pp-content">
      <header className="pp-topbar"><div className="pp-topbar-left"><button type="button" className="pp-mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileMenuOpen(true)}><Icon name="menu" /></button><div className="pp-breadcrumb"><span>Workspace</span><span>/</span><strong>{pageTitle[page]}</strong></div></div><div className="pp-topbar-right"><span className="pp-network-badge" data-testid="network-chip"><span className="pp-status-dot" />Stellar Testnet</span><button type="button" className="pp-wallet-button" disabled={!enabled || workflow.busy} onClick={() => void connect()} title={address || "Connect Freighter"}><Icon name="wallet" size={18} />{address ? shortAddress(address) : "Connect Wallet"}</button></div></header>
      <main className="pp-main">
        {config.mode === "prepare" && <div className="pp-notice">Preparation mode: wallet actions are unavailable.</div>}
        {config.mode === "disabled" && <div className="pp-notice pp-notice-error" role="alert">Payments unavailable: {config.message}</div>}
        {config.mode === "demo" && <div className="pp-notice">Demo mode uses a shared testnet deployment. Use a test wallet.</div>}
        {error && <div className="pp-notice pp-notice-error" role="alert">{error}</div>}
        {notice && <div className="pp-notice" role="status">{notice}</div>}

        {page === "home" && <>
          <div className="pp-page-heading"><div><div className="pp-eyebrow">WELCOME BACK, JUN</div><h1>Your family, <span>taken care of.</span></h1><p>Plan your support and keep everyone in the loop.</p></div><button type="button" className="pp-primary-button" onClick={() => navigate("padala")}><Icon name="send" size={17} />Send Padala</button></div>
          <div className="pp-dashboard-grid"><div className="pp-dashboard-main">
            <div className="pp-hero-card"><div className="pp-hero-top"><span>MONTHLY FAMILY BUDGET</span><span className="pp-hero-tag">Editable plan</span></div><div className="pp-hero-amount">{money(budget)}</div><p>Planned monthly support. Edit the budget or allocations below.</p><AllocationBar shares={shares} /><div className="pp-hero-footer"><span>4 family members</span><span>{totalPercentage}% assigned</span></div><button type="button" className="pp-secondary-button" style={{ marginTop: 16 }} onClick={() => navigate("family")}>Edit monthly budget <Icon name="arrow" size={16} /></button></div>
            <div className="pp-section-heading"><div><h2>Family allocations</h2><p>Jun 30% · Parents 40% · Brother 15% · Younger Sister 15% by default.</p></div><button type="button" className="pp-link-button" onClick={() => navigate("family")}>Edit allocations <Icon name="arrow" size={16} /></button></div>
            <div className="pp-allocation-list">{MEMBERS.map(member => <AllocationCard key={member.id} member={member} shares={shares} allowance={budget} onClick={() => { setSelectedMemberId(member.id); navigate("family"); }} />)}</div>
          </div><div className="pp-dashboard-side">
              <div className="pp-side-card"><div className="pp-card-icon"><Icon name="calendar" /></div><div className="pp-small-label">SCHEDULED PADALA</div><h3>{scheduled.schedule ? scheduled.schedule.paused ? "Schedule paused" : "Schedule running" : "Check your schedule"}</h3><p>{scheduled.schedule ? "Your scheduled contract is connected to Paiflow." : "Monitor your scheduled distribution."}</p><button type="button" className="pp-secondary-button" onClick={() => navigate("scheduled")}>View schedule <Icon name="arrow" size={16} /></button></div>
              <div className="pp-request-card"><div className="pp-request-icon"><Icon name="bell" /></div><div className="pp-small-label">EMERGENCY REQUESTS</div><h3>{requests.filter(r => r.status === "pending").length} pending request(s)</h3><p>{approvedRequests.length} approved locally. Approved requests are not blockchain payouts.</p><button type="button" className="pp-secondary-button" onClick={() => navigate("pot")}>Open Emergency Pot <Icon name="arrow" size={16} /></button></div>
              <div className="pp-side-card"><div className="pp-small-label">WALLET STATUS</div><h3>{address ? "Wallet connected" : "Connect Freighter"}</h3><p className="pp-address">{shortAddress(address)}</p><div className="pp-wallet-balance">
                <span className="pp-small-label">STELLAR TESTNET BALANCES</span>
                <div className="pp-preview-row"><span>XLM</span><strong>{walletLoading ? "Loading..." : walletXlm !== null ? `${Number(walletXlm).toLocaleString("en-US", { maximumFractionDigits: 7 })} XLM` : "—"}</strong></div>
                <div className="pp-preview-row"><span>USDC</span><strong>{walletLoading ? "Loading..." : walletXlm === null ? "—" : walletUsdc.length === 0 ? "0.00 USDC" : walletUsdc.length === 1 ? `${Number(walletUsdc[0]?.balance ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 7 })} USDC` : `${walletUsdc.length} trustlines`}</strong></div>
                {walletUsdc.map(token => <div key={token.issuer} className="pp-preview-row"><span className="pp-muted" title={token.issuer}>Issuer: {shortAddress(token.issuer)}</span><strong>{walletUsdc.length > 1 ? `${Number(token.balance).toLocaleString("en-US", { maximumFractionDigits: 7 })} USDC` : ""}</strong></div>)}
                <span className="pp-muted">USDC balances are reported from Stellar Testnet trustlines. Verify the issuer before treating a token as genuine USDC. Soroban-only token balances may not appear here.</span>
              </div>{walletError && <p className="pp-muted">{walletError}</p>}<div className="pp-button-row"><button type="button" className="pp-secondary-button" disabled={!enabled || workflow.busy} onClick={() => void connect()}><Icon name="wallet" size={16} />{address ? "Reconnect" : "Connect"}</button><button type="button" className="pp-icon-button" aria-label="Refresh wallet balance" disabled={!enabled || workflow.busy || walletLoading} onClick={() => void refreshConnectedWallet()}><Icon name="refresh" size={17} /></button></div></div>
            </div></div>
        </>}

        {page === "family" && <>
          <div className="pp-page-heading"><div><div className="pp-eyebrow">PEOPLE WHO MATTER</div><h1>Your <span>family circle.</span></h1><p>Four members, one editable monthly support plan.</p></div></div>
          <div className="pp-family-grid"><div className="pp-family-main">
            <div className="pp-section-heading"><div><h2>Monthly allowance</h2><p>Changes are saved in this browser.</p></div></div>
            <label className="pp-form-label">Monthly family budget (USDC)<div className="pp-amount-field"><input type="text" inputMode="decimal" value={allowance} onChange={event => setAllowance(event.target.value)} placeholder="2500.00" /><span>USDC</span></div></label>
            {decimal(allowance) === null && <p className="pp-allocation-error">Enter a valid nonnegative amount with at most two decimal places.</p>}
            <div className="pp-section-heading"><div><h2>Edit allocation percentages</h2><p>All four percentages must add up to exactly 100%.</p></div><button type="button" className="pp-text-button" onClick={() => setShares(DEFAULT_SHARES)}>Reset to defaults</button></div>
            <div className="pp-allocation-editor-list">{MEMBERS.map(member => <div className="pp-allocation-editor-row" key={member.id}><div className="pp-allocation-person"><Avatar initials={member.initials} /><div><strong>{member.name}</strong><p>{money(allocation(budget, shares[member.id]))}</p></div></div><label className="pp-percentage-input"><input type="number" min="0" max="100" step="1" aria-label={`${member.name} percentage`} value={shares[member.id]} onChange={event => changeShare(member.id, event.target.value)} /><span>%</span></label></div>)}</div>
            <div className="pp-allocation-total"><strong>Total allocated</strong><strong>{totalPercentage}% / 100%</strong></div>
            {!validShares && <p className="pp-allocation-error">Allocations must total exactly 100%. The current draft will not be saved until valid.</p>}
            <AllocationBar shares={shares} /><p className="pp-muted">This is your planning budget only. Editing percentages does not change the recipient wallets or split in the deployed Paiflow workflow.</p>
            <div className="pp-section-heading"><div><h2>Family members</h2><p>Only four members are included in the budget.</p></div></div>
            <div className="pp-family-list">{MEMBERS.map(member => <button type="button" key={member.id} className="pp-family-row pp-family-row-button" onClick={() => setSelectedMemberId(member.id)}><Avatar initials={member.initials} /><div className="pp-family-details"><strong>{member.name}</strong><p>{member.role}</p></div><Icon name="arrow" size={17} /></button>)}</div>
          </div><div className="pp-family-side"><div className="pp-side-card"><div className="pp-card-icon"><Icon name="heart" /></div><h3>Every share has a purpose.</h3><p>Jun, Parents, Brother and Younger Sister are the four members of this plan.</p><AllocationBar shares={shares} /></div><div className="pp-side-card">{selectedMember ? <><div className="pp-family-selected"><Avatar initials={selectedMember.initials} large /><h3>{selectedMember.name}</h3><p>{selectedMember.role}</p></div><div className="pp-member-amount">{money(allocation(budget, shares[selectedMember.id]))}</div><div className="pp-note">{selectedMember.purpose} · &quot;{selectedMember.note}&quot;</div><p className="pp-muted">{shares[selectedMember.id]}% of the planned monthly budget.</p></> : <><h3>Get to know your circle</h3><p>Select a family member to view their share.</p></>}</div></div></div>
        </>}

        {page === "padala" && <>
          <div className="pp-page-heading"><div><div className="pp-eyebrow">INSTANT TRANSFER</div><h1>Send with <span>malasakit.</span></h1><p>Review the amount and your family budget preview before signing.</p></div><span className="pp-soft-badge">On Receive → Split</span></div>
          <div className="pp-payment-grid"><div className="pp-payment-main"><div className="pp-white-card"><div className="pp-section-heading"><div><h2>Instant Padala</h2><p>Powered by Paiflow on Stellar Testnet.</p></div><div className="pp-card-icon"><Icon name="send" /></div></div>
            {discoveryError && <div className="pp-notice pp-notice-error" role="alert">{discoveryError}</div>}
            {enabled && !canPay && <div className="pp-notice">{discovery ? "This deployment does not support instant execution." : "Checking payment capabilities..."}</div>}
            <form onSubmit={event => { event.preventDefault(); try { setError(""); if (!validShares) throw new Error("Your budget allocations must total 100% before continuing."); if (paymentAmount === null || paymentAmount <= 0) throw new Error("Enter a positive payment amount."); void workflow.start("execute", address, { from: address, amount: toStroops(amount) }); } catch (cause) { setError(String(cause)); } }}>
              <label className="pp-form-label">Amount to send<div className="pp-amount-field"><input required type="text" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" /><span>{inputAssetVerifiedUSDC ? "USDC" : assetSymbol}</span></div></label>
              <div className="pp-payment-info"><Icon name="shield" size={20} /><p>Freighter will ask you to review and sign the transaction. The actual token and recipients are defined by your Paiflow deployment, not this preview. Confirm the asset in Freighter before signing.</p></div>
              {!inputAssetVerifiedUSDC && <div className="pp-notice">The instant deployment has not been verified as USDC. The budget preview uses USDC, but the on-chain transaction may use another asset. Check the asset and amount in Freighter.</div>}
              <button type="submit" className="pp-primary-button pp-wide-button" disabled={!canPay || workflow.blocked || !address || !validShares || paymentAmount === null || paymentAmount <= 0}><Icon name="send" size={18} />{workflow.busy ? "Processing transaction..." : "Review Instant Padala"}</button>
            </form>{workflow.message && <div className="pp-notice" role="status">{workflow.message}</div>}
          </div>
            {workflow.recovery && <div className="pp-white-card"><h2>Recover Existing Transaction</h2><p>Operation: {workflow.recovery.operation}</p><p className="pp-address">{workflow.recovery.prepared.txHash ?? "Transaction hash unavailable"}</p><p>Do not start another payment while this one is unresolved.</p><button type="button" className="pp-secondary-button" disabled={!enabled || workflow.busy} onClick={() => void workflow.reconcile()}>Check Transaction Again</button></div>}
            {discovery && <div className="pp-integration-panel"><DeploymentPanels capabilities={discovery} address={address} blocked={workflow.blocked} start={workflow.start} /></div>}
          </div><div className="pp-payment-side"><div className="pp-side-card"><div className="pp-small-label">FAMILY BUDGET PREVIEW</div><h3>Where your padala goes</h3><p>Preview of {money(paymentAmount ?? 0)} at your editable budget percentages. Not a confirmation of the deployed on-chain split.</p><AllocationBar shares={shares} />{MEMBERS.map(member => <div className="pp-preview-row" key={member.id}><span>{member.name} ({shares[member.id]}%)</span><strong>{money(allocation(paymentAmount ?? 0, shares[member.id]))}</strong></div>)}{!validShares && <p className="pp-allocation-error">Percentages currently total {totalPercentage}%, not 100%.</p>}</div><div className="pp-side-card"><div className="pp-card-icon"><Icon name="shield" /></div><h3>Transparent by design</h3><p>Actual payment recipients and split percentages are controlled by the deployed Paiflow workflow.</p><p className="pp-muted">Changing the budget preview does not reconfigure the blockchain deployment.</p></div></div></div>
        </>}

        {page === "scheduled" && <>
          <div className="pp-page-heading"><div><div className="pp-eyebrow">FUTURE DISTRIBUTIONS</div><h1>Plan ahead, <span>send with care.</span></h1><p>Monitor your deployed Scheduled Padala contract on Stellar Testnet.</p></div><button type="button" className="pp-secondary-button" disabled={!enabled || scheduledLoading} onClick={() => void loadScheduled()}><Icon name="refresh" size={17} />{scheduledLoading ? "Refreshing..." : "Refresh Schedule"}</button></div>
          {scheduledError && <div className="pp-notice pp-notice-error" role="alert">{scheduledError}</div>}
          {!scheduledReady && !scheduledError && <div className="pp-notice">{scheduledLoading ? "Loading scheduled contract..." : "Schedule information unavailable."}</div>}
          <div className="pp-stats-grid"><div className="pp-stat-card"><div className="pp-small-label">SCHEDULE STATUS</div><h3>{scheduled.schedule ? scheduled.schedule.paused ? "Paused" : "Running" : "Unavailable"}</h3><p>{scheduled.schedule ? "Live contract state" : "Waiting for contract data"}</p></div><div className="pp-stat-card"><div className="pp-small-label">CONTRACT BALANCE</div><h3>{scheduled.schedule?.balanceStroops ?? "—"}</h3><p>Raw token units</p></div><div className="pp-stat-card"><div className="pp-small-label">AVAILABLE TO CLAIM</div><h3>{scheduled.schedule?.availableStroops ?? "—"}</h3><p>Raw token units</p></div></div>
          <div className="pp-payment-grid"><div className="pp-payment-main"><div className="pp-white-card"><div className="pp-section-heading"><div><h2>Scheduled funding</h2><p>Prefund the schedule contract for future distributions.</p></div><div className="pp-card-icon"><Icon name="calendar" /></div></div>{scheduled.capabilities && <div className="pp-detail-list"><div><span>Network</span><strong>{scheduled.capabilities.network}</strong></div><div><span>Trigger</span><strong>{scheduled.capabilities.triggerType}</strong></div><div><span>Asset</span><strong>{scheduled.capabilities.inputAsset?.kind === "known" ? scheduled.capabilities.inputAsset.symbol : "Unknown"}</strong></div><div><span>Funding support</span><strong>{scheduled.capabilities.operations?.funding?.status ?? "Unknown"}</strong></div></div>}<button type="button" className="pp-primary-button pp-wide-button" disabled>Fund Scheduled Padala (Verification Pending)</button><p className="pp-muted">Funding is disabled until token precision and wallet authorization are verified.</p><div className="pp-payment-info"><Icon name="shield" size={20} /><p>Funding adds tokens to the schedule contract. It does not immediately pay recipients.</p></div></div>{scheduled.schedule && <div className="pp-white-card"><h2>Live contract information</h2><div className="pp-detail-list"><div><span>Claimed</span><strong>{scheduled.schedule.claimedStroops}</strong></div><div><span>Paused</span><strong>{scheduled.schedule.paused ? "Yes" : "No"}</strong></div><div><span>Last updated</span><strong>{dateText(scheduled.schedule.readAt)}</strong></div></div><p className="pp-small-label">CONTROLLER</p><p className="pp-address">{scheduled.schedule.controller}</p></div>}</div><div className="pp-payment-side"><div className="pp-side-card"><div className="pp-small-label">PAIFLOW DEPLOYMENT</div><h3>On Schedule → Split</h3><p className="pp-address">{SCHEDULED_DEPLOYMENT_ID}</p>{scheduledNode && <><div className="pp-detail-list"><div><span>Node</span><strong>{scheduledNode.nodeId}</strong></div><div><span>Action</span><strong>{scheduledNode.action}</strong></div></div><p className="pp-small-label">CONTRACT ADDRESS</p><p className="pp-address">{scheduledNode.contractAddress}</p><p className="pp-small-label">TOKEN CONTRACT</p><p className="pp-address">{scheduledNode.tokenContractAddress}</p></>}</div><div className="pp-request-card"><div className="pp-small-label">IMPORTANT</div><h3>Scheduled does not mean paid</h3><p>Verify actual on-chain payouts separately.</p></div></div></div>
        </>}

        {page === "pot" && <>
          <div className="pp-page-heading"><div><div className="pp-eyebrow">FAMILY SAFETY NET</div><h1>Emergency <span>support for Parents.</span></h1><p>Request, review and approve emergency support separately from the monthly allocations.</p></div><span className="pp-soft-badge">Demo approvals · No automatic payout</span></div>
          <div className="pp-payment-grid"><div className="pp-payment-main">
            <div className="pp-hero-card"><div className="pp-hero-top"><span>EMERGENCY POT · REQUEST WORKFLOW</span><span className="pp-hero-tag">Separate from budget</span></div><div className="pp-hero-amount">Parents</div><p>Approved emergency requests are intended for the Parents' wallet. No reserve balance or payout contract is connected yet.</p></div>
            <div className="pp-white-card"><h2>New emergency request</h2><p>Enter an amount and a reason. One approval is recorded as a demo starting state; a second approval is required.</p><form onSubmit={createEmergencyRequest}><label className="pp-form-label">Requested amount<div className="pp-amount-field"><input type="text" inputMode="decimal" value={requestAmount} onChange={event => setRequestAmount(event.target.value)} placeholder="100.00" required /><span>USDC</span></div></label><label className="pp-form-label">Reason<div className="pp-amount-field"><input type="text" value={requestReason} onChange={event => setRequestReason(event.target.value)} placeholder="e.g. Parents' medical expenses" maxLength={180} required /></div></label><button type="submit" className="pp-primary-button pp-wide-button"><Icon name="plus" size={17} />Submit emergency request</button></form></div>
            <div className="pp-white-card"><div className="pp-section-heading"><div><h2>Emergency requests</h2><p>Approval records are saved only in this browser.</p></div><div className="pp-card-icon"><Icon name="heart" /></div></div>{requests.length === 0 && <div className="pp-empty-state"><Icon name="heart" size={32} /><h3>No requests yet</h3><p>Submit a request above to demonstrate the approval flow.</p></div>}{requests.map(request => <div key={request.id} style={{ padding: "16px 0", borderBottom: "1px solid #e2ebe6" }}><div className="pp-preview-row"><span>Requested for Parents</span><strong>{money(decimal(request.amount) ?? 0)}</strong></div><p>{request.reason}</p><p className="pp-muted">{dateText(request.createdAt)} · {request.status === "approved" ? "Approved — awaiting separate payment" : request.status === "declined" ? "Declined" : "Pending approval"}</p><div className="pp-approval-progress"><div style={{ width: request.approvals === 2 ? "100%" : "50%" }} /></div><strong>{request.approvals} of 2 demo approvals</strong>{request.status === "pending" && <div className="pp-button-row"><button type="button" className="pp-primary-button" onClick={() => decideRequest(request.id, true)}>Approve request</button><button type="button" className="pp-outline-button" onClick={() => decideRequest(request.id, false)}>Decline</button></div>}{request.status === "approved" && <><div className="pp-notice" style={{ marginTop: 14 }}>Approved for Parents. No USDC was sent. The real payout must be implemented and authorized separately.</div><button type="button" className="pp-secondary-button" onClick={() => { setAmount(request.amount); navigate("padala"); setNotice("Emergency request amount loaded into Instant Padala for review. IMPORTANT: the existing Paiflow instant split is NOT a direct Parents payout. Do not sign expecting Parents to receive the entire amount."); }}>Review payment options <Icon name="arrow" size={16} /></button></>}</div>)}</div>
          </div><div className="pp-payment-side"><div className="pp-side-card"><div className="pp-card-icon"><Icon name="shield" /></div><h3>How approval works</h3><p>1. A family member requests emergency funds.</p><p>2. Two designated family members approve.</p><p>3. An authorized transaction must send the requested amount to Parents.</p><p>4. Only a confirmed blockchain transaction counts as paid.</p><p className="pp-muted">Steps 1 and 2 are currently a local demo. Steps 3 and 4 need a verified Parents wallet, a funded reserve, and an appropriate smart contract or transfer flow.</p></div></div></div>
        </>}

        {page === "activity" && <><div className="pp-page-heading"><div><div className="pp-eyebrow">TRANSPARENCY</div><h1>Your padala, <span>on record.</span></h1><p>Review events reported by your Paiflow deployment.</p></div></div><div className="pp-white-card"><div className="pp-section-heading"><div><h2>Blockchain activity</h2><p>Events may appear after a short delay.</p></div><div className="pp-card-icon"><Icon name="history" /></div></div>{activity.error && <div className="pp-notice pp-notice-error" role="alert">{activity.error}</div>}{activity.events.length === 0 && <div className="pp-empty-state"><Icon name="history" size={32} /><h3>No events to display yet</h3><p>Paiflow deployment events will appear here when available.</p></div>}<div className="pp-activity-list">{activity.events.map(event => <div key={event.eventId} className="pp-activity-item"><div className="pp-activity-icon"><Icon name="check" /></div><div className="pp-activity-details"><strong>{event.kind}</strong>{event.topic && <p>{event.topic}</p>}<span>{dateText(event.occurredAt)}</span><details><summary>Event details</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details></div>{event.txHash && <a className="pp-link-button" href={`https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(event.txHash)}`} target="_blank" rel="noreferrer">View transaction <Icon name="external" size={16} /></a>}</div>)}</div></div></>}
        <footer className="pp-footer"><span>Padala Pabalik · Padala na may malasakit</span><span>Stellar Testnet · Powered by Paiflow</span></footer>
      </main>
    </div>
  </div>;
}
