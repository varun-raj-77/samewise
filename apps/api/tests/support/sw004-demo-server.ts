import { buildApp } from "../../src/app.js";
import type { SemanticMapper } from "../../src/semantic-mapper.js";

const semanticMapper: SemanticMapper = {
  async propose() {
    return {
      provider: "openai",
      model: "mock-semantic-mapper-for-ui-walkthrough",
      responseId: "mock-response-sw004-walkthrough",
      output: {
        mappings: [
          { leftColumn: "vendor_name", rightColumn: "organization", relation: "equivalent", role: "identity", confidence: 0.96, reason: "Both columns appear to contain organization names.", normalizationHints: ["casefold", "corporate_suffix_normalization"] },
          { leftColumn: "phone", rightColumn: "telephone", relation: "equivalent", role: "identity", confidence: 0.89, reason: "Both columns appear to contain telephone numbers.", normalizationHints: ["phone_digits"] },
          { leftColumn: "website", rightColumn: "email_address", relation: "related_but_not_equivalent", role: "identity", confidence: 0.51, reason: "Both may contain internet contact information, but their semantics are uncertain.", normalizationHints: ["casefold"] },
        ],
        unmappedLeft: ["vendor_id", "contact_email", "street", "city", "state", "zip", "account_status", "balance", "updated_at"],
        unmappedRight: ["organization_ref", "address_line_1", "locality", "region", "postal_code", "domain", "status", "outstanding_balance", "last_updated"],
      },
    };
  },
};

const app = buildApp({ logger: true, semanticMapper });
await app.listen({ host: "127.0.0.1", port: 3000 });
