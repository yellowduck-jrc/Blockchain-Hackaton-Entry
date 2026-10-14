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
