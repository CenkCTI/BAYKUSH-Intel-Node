import type { SourceAdapter } from "../contracts/source.js";
import { createCertEuPublicationAdapter } from "./cert-eu-publications.js";
import { createCisaIcsCsafAdapter } from "./cisa-ics-csaf.js";
import { createJvnIpediaAdapter } from "./jvn-ipedia.js";
import { createMitreAttackEnterpriseAdapter } from "./mitre-attack-enterprise.js";
import { createNode5PackageSource } from "./node5-package-source.js";
import { createSiemensProductCertAdapter } from "./siemens-productcert.js";

const mitreRawJsonFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const requestUrl = input instanceof Request ? new URL(input.url) : new URL(input.toString());
  if (response.status !== 200 || requestUrl.hostname !== "raw.githubusercontent.com") return response;
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

export const node5Adapters: SourceAdapter[] = [
  createNode5PackageSource(),
  createMitreAttackEnterpriseAdapter({ fetchImpl: mitreRawJsonFetch }),
  createJvnIpediaAdapter(),
  createCisaIcsCsafAdapter(),
  createCertEuPublicationAdapter(),
  createSiemensProductCertAdapter(),
];
