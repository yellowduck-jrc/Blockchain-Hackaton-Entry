"use client";

import { useEffect, useMemo, useState } from "react";

type Category = "Electricity" | "Water" | "Internet" | "Mobile Load" | "Rent" | "Groceries" | "Education" | "Other";
type Bill = { id: string; category: Category; title: string; amount: number; amountUsdc?: number; dueDate: string; paid: boolean };
const STORAGE_KEY = "padala-pabalik-billing-v1";
const CATEGORIES: { name: Category; icon: string; description: string }[] = [
  { name: "Electricity", icon: "⚡", description: "Electric bills" },
  { name: "Water", icon: "💧", description: "Water utility" },
  { name: "Internet", icon: "🌐", description: "Wi-Fi and broadband" },
  { name: "Mobile Load", icon: "📱", description: "Phone and data" },
  { name: "Rent", icon: "🏠", description: "Housing expenses" },
  { name: "Groceries", icon: "🛒", description: "Household essentials" },
  { name: "Education", icon: "🎓", description: "School expenses" },
  { name: "Other", icon: "📋", description: "Other bills" },
];
const peso = (n: number) => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);
const isCategory = (v: unknown): v is Category => CATEGORIES.some(c => c.name === v);
function dueText(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "No due date";
  const parts = value.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return "Invalid due date";
  return date.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
}
export function Billing({ phpRate }: { phpRate: number | null }) {
  const [bills, setBills] = useState<Bill[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [category, setCategory] = useState<Category>("Electricity");
  const [title, setTitle] = useState("");
  const [amountPhp, setAmountPhp] = useState("");
  const rate = phpRate ?? 0;
  const validRate = Number.isFinite(rate) && rate > 0;
  const convertedUsdc = validRate && amountPhp.trim() !== "" && Number.isFinite(Number(amountPhp)) ? Number(amountPhp) / rate : null;
  const [dueDate, setDueDate] = useState("");
  const [filter, setFilter] = useState<Category | "All">("All");
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setBills(parsed.filter((item): item is Bill =>
            !!item && typeof item === "object" && typeof item.id === "string" &&
            isCategory(item.category) && typeof item.title === "string" &&
            typeof item.amount === "number" && Number.isFinite(item.amount) && item.amount >= 0 &&
            typeof item.dueDate === "string" && typeof item.paid === "boolean"
          ));
        }
      }
    } catch { /* Keep empty list if browser storage is unavailable. */ }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(bills)); } catch { /* Browser storage unavailable. */ }
  }, [bills, loaded]);

  const totals = useMemo(() => ({
    total: bills.reduce((sum, bill) => sum + bill.amount, 0),
    unpaid: bills.filter(bill => !bill.paid).reduce((sum, bill) => sum + bill.amount, 0),
    paid: bills.filter(bill => bill.paid).reduce((sum, bill) => sum + bill.amount, 0),
  }), [bills]);
  const visible = useMemo(() => bills.filter(bill => filter === "All" || bill.category === filter).sort((a, b) =>
    Number(a.paid) - Number(b.paid) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999")
  ), [bills, filter]);
  function addBill(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const numericPhp = Number(amountPhp);
    if (!title.trim()) { setError("Enter a bill name."); return; }
    if (!/^\d+(?:\.\d{1,2})?$/.test(amountPhp) || !Number.isFinite(numericPhp) || numericPhp <= 0) {
      setError("Enter a positive PHP amount (up to two decimal places)."); return;
    }
    if (dueDate && dueText(dueDate) === "Invalid due date") { setError("Enter a valid due date."); return; }
    setBills(previous => [...previous, {
      id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      category, title: title.trim(), amount: numericPhp, ...(convertedUsdc !== null ? { amountUsdc: convertedUsdc } : {}), dueDate, paid: false,
    }]);
    setTitle(""); setAmountPhp(""); setDueDate(""); setError("");
  }
  const fieldStyle: React.CSSProperties = { width: "100%", padding: "12px", borderRadius: 9, border: "1px solid #d7e4df", background: "#fff", color: "#153f37", font: "inherit" };
  return <>
    <div className="pp-page-heading"><div><div className="pp-eyebrow">HOUSEHOLD EXPENSES</div><h1>Family <span>Billing.</span></h1><p>Organize household bills, due dates, and payment plans in one place.</p></div></div>
    <div className="pp-stats-grid">
      <div className="pp-stat-card"><div className="pp-small-label">TOTAL RECORDED</div><h3>{peso(totals.total)}</h3><p>All bills</p></div>
      <div className="pp-stat-card"><div className="pp-small-label">UNPAID BILLS</div><h3>{peso(totals.unpaid)}</h3><p>{bills.filter(b => !b.paid).length} awaiting payment</p></div>
      <div className="pp-stat-card"><div className="pp-small-label">MARKED PAID</div><h3>{peso(totals.paid)}</h3><p>{bills.filter(b => b.paid).length} marked as paid</p></div>
    </div>
    <div className="pp-white-card" style={{ marginBottom: 20 }}>
      <div className="pp-section-heading"><div><h2>Bill categories</h2><p>Select a category to view its bills.</p></div></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))", gap: 12 }}>
        {CATEGORIES.map(item => <button key={item.name} type="button" onClick={() => { setFilter(item.name); setCategory(item.name); }} style={{ textAlign: "left", cursor: "pointer", padding: 16, borderRadius: 12, background: filter === item.name ? "#e4f4ec" : "#f8faf9", border: `1px solid ${filter === item.name ? "#65a994" : "#e1eae5"}`, color: "#153f37" }}>
          <div style={{ fontSize: 25, marginBottom: 8 }}>{item.icon}</div><strong>{item.name}</strong>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{item.description}</div>
          <div style={{ fontSize: 12, marginTop: 8 }}>{bills.filter(b => b.category === item.name).length} bill(s)</div>
        </button>)}
      </div>
    </div>
    <div className="pp-payment-grid">
      <div className="pp-payment-main">
        <div className="pp-white-card">
          <div className="pp-section-heading"><div><h2>Recorded bills</h2><p>Track upcoming dues and mark bills as paid.</p></div><button type="button" className="pp-secondary-button" onClick={() => setFilter("All")}>Show all</button></div>
          <p className="pp-muted">Showing: {filter === "All" ? "All categories" : filter}</p>
          {visible.length === 0 ? <div className="pp-empty-state"><h3>No bills yet</h3><p>Add a bill using the form to start tracking expenses.</p></div> : visible.map(bill => {
            const late = !bill.paid && bill.dueDate !== "" && bill.dueDate < new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" });
            return <div key={bill.id} style={{ padding: "16px 0", borderBottom: "1px solid #e5ebe8" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div><strong>{CATEGORIES.find(c => c.name === bill.category)?.icon} {bill.title}</strong><p className="pp-muted" style={{ margin: "6px 0" }}>{bill.category} · Due {dueText(bill.dueDate)}</p><span style={{ fontSize: 12, color: bill.paid ? "#187858" : late ? "#aa4a27" : "#647b71" }}>{bill.paid ? "Marked paid" : late ? "Past due" : "Unpaid"}</span></div>
                <div style={{ textAlign: "right" }}><strong>{peso(bill.amount)}</strong>{bill.amountUsdc !== undefined ? <p className="pp-muted" style={{ margin: "4px 0" }}>{bill.amountUsdc.toLocaleString("en-US", { maximumFractionDigits: 7 })} USDC at entry</p> : validRate && <p className="pp-muted" style={{ margin: "4px 0" }}>≈ {(bill.amount / rate).toFixed(2)} USDC (legacy bill)</p>}</div>
              </div>
              <div className="pp-button-row" style={{ marginTop: 10 }}>
                <button type="button" className="pp-secondary-button" onClick={() => setBills(prev => prev.map(item => item.id === bill.id ? { ...item, paid: !item.paid } : item))}>{bill.paid ? "Mark unpaid" : "Mark paid"}</button>
                <button type="button" className="pp-text-button" onClick={() => { if (window.confirm(`Remove ${bill.title}?`)) setBills(prev => prev.filter(item => item.id !== bill.id)); }}>Remove</button>
              </div>
            </div>;
          })}
        </div>
      </div>
      <div className="pp-payment-side"><div className="pp-side-card">
        <div className="pp-small-label">NEW BILL</div><h3>Add a household bill</h3><p>Enter the bill in pesos; the USDC estimate updates automatically.</p>
        <form onSubmit={addBill} style={{ display: "grid", gap: 14, marginTop: 16 }}>
          <label className="pp-form-label">Category<select value={category} onChange={event => setCategory(event.target.value as Category)} style={fieldStyle}>{CATEGORIES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
          <label className="pp-form-label">Bill name<input required maxLength={80} value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Meralco October" style={fieldStyle}/></label>
          <label className="pp-form-label">Amount (PHP)<input required inputMode="decimal" value={amountPhp} onChange={event => setAmountPhp(event.target.value)} placeholder="e.g. 1800.00" style={fieldStyle}/></label>
          <label className="pp-form-label">Amount (USDC)<input readOnly aria-label="Converted amount in USDC" value={convertedUsdc === null ? "" : convertedUsdc.toFixed(7)} placeholder={validRate ? "Enter PHP above" : "Exchange rate unavailable"} style={{ ...fieldStyle, background: "#f3f7f5", cursor: "not-allowed" }}/></label>
          <p className="pp-muted" style={{ margin: "-6px 0 0", fontSize: 12 }}>{validRate ? `Reference estimate: 1 USDC ≈ ${peso(rate)}. Actual redemption rates and fees may differ.` : "Waiting for the USDC/PHP reference rate. You can still record a PHP bill."}</p>
          <label className="pp-form-label">Due date<input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} style={fieldStyle}/></label>
          {error && <p className="pp-allocation-error" role="alert">{error}</p>}
          <button type="submit" className="pp-primary-button pp-wide-button">Add bill</button>
        </form>
      </div><div className="pp-request-card"><div className="pp-small-label">IMPORTANT</div><h3>Budget tracking only</h3><p>Marking a bill paid updates this browser's records. It does not send USDC, pay a biller, or verify an on-chain payment.</p></div></div>
    </div>
  </>;
}
