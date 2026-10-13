
"use client";

import { useEffect, useRef, useState } from "react";

import {
  browserRequest,
  retryDelay,
  IntegrationError,
  preparationDefinitelyRefused,
} from "@/lib/browser-api";

import { signPrepared } from "@/lib/wallet";

import {
  readRecovery,
  canResumeEnvelope,
  replacementSafe,
  recoverySettled,
  type Recovery,
  type Operation,
} from "@/lib/recovery";

export type { Recovery, Operation } from "@/lib/recovery";
export { replacementSafe } from "@/lib/recovery";

export function useWalletOperation(
  scope: string,
  enabled: boolean,
  integrationEndpoint = "/api/integration",
) {
  const key = `paiflow:operation:v1:${scope}`;
  const preparationKey = `${key}:preparing`;

  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");

  const lock = useRef(false);
  const retryAt = useRef(0);
  const storageBlocked = useRef(false);

  useEffect(() => {
    setLoaded(false);
    lock.current = false;
    storageBlocked.current = false;

    try {
      if (localStorage.getItem(preparationKey)) {
        storageBlocked.current = true;

        setMessage(
          "A preparation response was lost. Retain the pending preparation record and request platform support to recover its original intent; do not create a replacement.",
        );
      }

      const saved = localStorage.getItem(key);

      if (saved) {
        const r = readRecovery(scope, saved);

        setRecovery(r);

        setMessage(
          "An existing operation needs reconciliation before another transaction.",
        );
      } else {
        setRecovery(null);
      }
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "Recovery storage unavailable.",
      );

      storageBlocked.current = true;
    }

    setLoaded(true);
  }, [key, scope, preparationKey]);

  function save(r: Recovery) {
    setRecovery(r);

    // Save recovery information before signing or submitting.
    try {
      localStorage.setItem(key, JSON.stringify(r));
    } catch (e) {
      storageBlocked.current = true;
      throw e;
    }
  }

  function finish() {
    localStorage.removeItem(key);
    setRecovery(null);
  }

  async function submit(r: Recovery) {
    if (!r.signedXdr) {
      throw new Error(
        "No saved signature. Reconcile the preparation; do not create a replacement.",
      );
    }

    const attempted = {
      ...r,
      attempted: true,
    };

    save(attempted);

    const data =
      r.operation === "execute"
        ? await browserRequest<{
            status: string;
            txHash: string;
          }>(
            "/api/pay",
            {
              signedXdr: r.signedXdr,
            },
            r.prepared.preparationRequestId
              ? {
                  "x-preparation-request-id":
                    r.prepared.preparationRequestId,
                }
              : undefined,
          )
        : await browserRequest<{
            status: string;
            txHash: string;
          }>(
            integrationEndpoint,
            {
              operation: r.operation,
              phase: "submit",
              input: {
                intent: r.prepared.intent,
                signedXdr: r.signedXdr,
                ...(r.operation === "funding"
                  ? { action: r.prepared.action }
                  : {}),
              },
            },
          );

    save({
      ...attempted,
      prepared: {
        ...r.prepared,
        txHash: data.txHash,
      },
    });

    setMessage(
      `${data.status} · ${data.txHash}. Activity can arrive later.`,
    );

    if (
      r.operation === "execute" &&
      replacementSafe(data, false)
    ) {
      finish();
    }
  }

  async function run(action: () => Promise<void>) {
    if (
      !enabled ||
      !loaded ||
      lock.current ||
      storageBlocked.current ||
      Date.now() < retryAt.current
    ) {
      return;
    }

    lock.current = true;
    setBusy(true);
    setMessage("");

    try {
      if (!navigator.locks) {
        throw new Error(
          "This browser cannot serialize wallet operations across tabs. Use a supported browser.",
        );
      }

      await navigator.locks.request(
        key,
        { ifAvailable: true },
        async (lease) => {
          if (!lease) {
            throw new Error(
              "Another tab is handling this deployment's transaction. Return to that tab.",
            );
          }

          await action();
        },
      );
    } catch (e) {
      retryAt.current = Date.now() + retryDelay(e);

      setMessage(
        e instanceof Error
          ? e.message
          : "Unresolved operation. Check the original operation again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function start(
    operation: Operation,
    address: string,
    input: unknown,
  ) {
    await run(async () => {
      if (recovery || localStorage.getItem(key)) {
        throw new Error(
          "Reconcile the existing operation first.",
        );
      }

      if (localStorage.getItem(preparationKey)) {
        throw new Error(
          "Original preparation unresolved; request operator recovery.",
        );
      }

      try {
        localStorage.setItem(
          preparationKey,
          JSON.stringify({
            scope,
            operation,
            address,
            createdAt: new Date().toISOString(),
          }),
        );
      } catch (e) {
        storageBlocked.current = true;
        throw e;
      }

      let prepared: Recovery["prepared"];

      try {
        prepared = await browserRequest<Recovery["prepared"]>(
          operation === "execute"
            ? "/api/pay"
            : integrationEndpoint,
          operation === "execute"
            ? input
            : {
                operation,
                phase: "prepare",
                input,
              },
        );
      } catch (e) {
        if (preparationDefinitelyRefused(e)) {
          localStorage.removeItem(preparationKey);
        } else {
          storageBlocked.current = true;

          localStorage.setItem(
            preparationKey,
            JSON.stringify({
              scope,
              operation,
              address,
              error:
                e instanceof Error
                  ? e.message
                  : "Unresolved",
              ...(e instanceof IntegrationError
                ? {
                    requestId: e.requestId,
                    details: e.details,
                  }
                : {}),
            }),
          );
        }

        throw e;
      }

      let r: Recovery;

      try {
        r = readRecovery(
          scope,
          JSON.stringify({
            version: 1,
            scope,
            operation,
            address,
            prepared,
          }),
        );
      } catch (e) {
        storageBlocked.current = true;
        throw e;
      }

      save(r);

      localStorage.removeItem(preparationKey);

      r = {
        ...r,
        signing: true,
      };

      save(r);

      const signedXdr = await signPrepared(
        prepared,
        address,
      );

      r = {
        ...r,
        signedXdr,
        signing: false,
      };

      save(r);

      await submit(r);
    });
  }

  async function reconcile() {
    await run(async () => {
      const saved = localStorage.getItem(key);

      if (!saved) {
        setRecovery(null);
        return;
      }

      const r = readRecovery(scope, saved);

      setRecovery(r);

      // Preserve the original transaction hash.
      if (
        r.operation === "execute" &&
        !r.prepared.txHash
      ) {
        const original = await browserRequest<{
          txHash: string;
        }>(
          integrationEndpoint,
          {
            operation: "execute",
            phase: "prepare",
            input: {
              xdr: r.prepared.xdr,
            },
          },
        );

        r.prepared = {
          ...r.prepared,
          txHash: original.txHash,
        };

        save(r);
      }

      if (canResumeEnvelope(r)) {
        save({
          ...r,
          signing: true,
        });

        const signedXdr = await signPrepared(
          r.prepared,
          r.address,
        );

        const signed = {
          ...r,
          signedXdr,
          signing: false,
        };

        save(signed);

        await submit(signed);
        return;
      }

      if (r.operation === "execute") {
        const data = await browserRequest<{
          status: string;
          txHash: string;
        }>(
          integrationEndpoint,
          {
            operation: "execute",
            phase: "reconcile",
            input: {
              xdr: r.prepared.xdr,
            },
          },
        );

        const reconciled = {
          ...r,
          prepared: {
            ...r.prepared,
            txHash: data.txHash,
          },
        };

        save(reconciled);

        setMessage(
          `${data.status} · ${data.txHash}`,
        );

        if (replacementSafe(data, false)) {
          finish();
          return;
        }

        if (r.signedXdr) {
          await submit(reconciled);
        } else {
          setMessage(
            `${data.status} · ${data.txHash}. The original envelope has expired and no signature is saved. Keep this record and request platform support to establish finality or ledger-covered noninclusion; the published execute API cannot prove safe replacement from expiry or NOT_FOUND.`,
          );
        }

        return;
      }

      const result = await browserRequest<{
        status?: string;
        state?: string;
        replacementAllowed?: boolean;
        txHash: string;
      }>(
        integrationEndpoint,
        {
          operation: r.operation,
          phase: "reconcile",
          input: {
            intent: r.prepared.intent,
            ...(r.operation === "funding"
              ? { action: r.prepared.action }
              : {}),
          },
        },
      );

      setMessage(
        `${result.status ?? result.state} · ${result.txHash}`,
      );

      const safe = recoverySettled(
        r.operation,
        result,
      );

      if (safe) {
        finish();
        return;
      }

      if (r.signedXdr) {
        await submit(r);
      } else {
        setMessage(
          "No saved signature; retain this intent and reconcile until the API establishes finality or expiry. Contact support if unresolved.",
        );
      }
    });
  }

  return {
    recovery,
    busy,
    message,
    loaded,
    start,
    reconcile,
    blocked:
      !loaded ||
      !!recovery ||
      busy ||
      storageBlocked.current,
  };
}
