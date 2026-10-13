
"use client";

export type Allocation = {
  initials: string;
  name: string;
  percentage: number;
};

type AllocationEditorProps = {
  budget: number;
  allocations: Allocation[];
  onBudgetChange: (budget: number) => void;
  onAllocationsChange: (allocations: Allocation[]) => void;
  onSave: () => void;
  onReset: () => void;
};

export function AllocationEditor({
  budget,
  allocations,
  onBudgetChange,
  onAllocationsChange,
  onSave,
  onReset,
}: AllocationEditorProps) {
  const total = allocations.reduce(
    (sum, item) => sum + item.percentage,
    0,
  );

  const valid =
    Number.isFinite(budget) &&
    budget > 0 &&
    allocations.every(
      (item) =>
        Number.isFinite(item.percentage) &&
        item.percentage >= 0 &&
        item.percentage <= 100,
    ) &&
    Math.abs(total - 100) < 0.000001;

  function updatePercentage(
    initials: string,
    percentage: number,
  ) {
    onAllocationsChange(
      allocations.map((item) =>
        item.initials === initials
          ? { ...item, percentage }
          : item,
      ),
    );
  }

  return (
    <div className="pp-white-card">
      <div className="pp-section-heading">
        <div>
          <h2>Edit family allocations</h2>
          <p>
            Customize your monthly budget and
            each recipient&apos;s share.
          </p>
        </div>
      </div>

      <label className="pp-form-label">
        Monthly family budget (USDC)
        <div className="pp-amount-field">
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={budget}
            onChange={(event) =>
              onBudgetChange(Number(event.target.value))
            }
          />
          <span>USDC</span>
        </div>
      </label>

      <div className="pp-allocation-editor-list">
        {allocations.map((item) => {
          const calculatedAmount =
            (budget * item.percentage) / 100;

          return (
            <div
              className="pp-allocation-editor-row"
              key={item.initials}
            >
              <div>
                <strong>{item.name}</strong>
                <p>
                  {calculatedAmount.toFixed(2)} USDC
                </p>
              </div>

              <div className="pp-percentage-input">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  aria-label={`${item.name} allocation percentage`}
                  value={item.percentage}
                  onChange={(event) =>
                    updatePercentage(
                      item.initials,
                      Number(event.target.value),
                    )
                  }
                />
                <span>%</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="pp-allocation-total">
        <strong>Total allocation</strong>
        <strong
          style={{
            color: valid ? "#116b5b" : "#ad423d",
          }}
        >
          {total}% / 100%
        </strong>
      </div>

      {!valid && (
        <p className="pp-allocation-error" role="alert">
          Enter a positive budget and make sure
          all percentages add up to exactly 100%.
        </p>
      )}

      <p className="pp-muted">
        These settings control your family budget
        preview only. They do not change the
        deployed Paiflow smart contract.
      </p>

      <div className="pp-button-row">
        <button
          type="button"
          className="pp-primary-button"
          disabled={!valid}
          onClick={onSave}
        >
          Save allocations
        </button>

        <button
          type="button"
          className="pp-outline-button"
          onClick={onReset}
        >
          Reset defaults
        </button>
      </div>
    </div>
  );
}
