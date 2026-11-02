import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExportVerifierWorkspace } from "./ExportVerifierWorkspace.js";
import { BrowserExportVerificationError, verifyBrowserExport } from "./export-verifier.js";

vi.mock("./export-verifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./export-verifier.js")>();
  return { ...actual, verifyBrowserExport: vi.fn() };
});

function browserFile(filename: string, content: string): File {
  const bytes = new TextEncoder().encode(content);
  const file = new File([bytes], filename);
  Object.defineProperty(file, "text", { value: async () => content });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  return file;
}

function openWithFiles() {
  render(<ExportVerifierWorkspace />);
  fireEvent.click(screen.getByText(/Verify downloaded files on this device/));
  const verifyButton = screen.getByRole("button", { name: "Check file integrity" });
  expect(verifyButton).toBeDisabled();
  const manifest = screen.getByLabelText("Provenance manifest for verification");
  const report = screen.getByLabelText("Reconciliation report for verification");
  const trusted = screen.getByLabelText("Trusted merged output for verification");
  fireEvent.change(manifest, { target: { files: [browserFile("manifest.json", '{"runId":"example"}')] } });
  fireEvent.change(report, { target: { files: [browserFile("report.csv", "PRIVATE-ROW-CONTENT")] } });
  expect(verifyButton).toBeEnabled();
  return { manifest, report, trusted, verifyButton };
}

beforeEach(() => { vi.mocked(verifyBrowserExport).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("SW-034 export verification UI", () => {
  it("checks locally selected files, includes optional trusted CSV, and clears stale success after changes", async () => {
    vi.mocked(verifyBrowserExport).mockResolvedValue({
      runId: "run-example", status: "trusted_ready",
      verified: [
        { kind: "reconciliation_report", filename: "report.csv", byteLength: 19 },
        { kind: "trusted_merged_output", filename: "trusted.csv", byteLength: 8 },
      ],
    });
    const { report, trusted, verifyButton } = openWithFiles();
    fireEvent.change(trusted, { target: { files: [browserFile("trusted.csv", "id,name")] } });
    fireEvent.click(verifyButton);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("File integrity verified"));
    expect(vi.mocked(verifyBrowserExport)).toHaveBeenCalledWith(
      { runId: "example" },
      [
        { filename: "report.csv", bytes: expect.anything() },
        { filename: "trusted.csv", bytes: expect.anything() },
      ],
    );
    const checked = vi.mocked(verifyBrowserExport).mock.calls[0]?.[1];
    expect(new TextDecoder().decode(checked?.[0]?.bytes)).toBe("PRIVATE-ROW-CONTENT");
    expect(screen.queryByText("PRIVATE-ROW-CONTENT")).not.toBeInTheDocument();
    fireEvent.change(report, { target: { files: [browserFile("replacement.csv", "new content")] } });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports verification failures without showing CSV contents and clears errors on new selection", async () => {
    vi.mocked(verifyBrowserExport).mockRejectedValue(new BrowserExportVerificationError("sha256_mismatch", "A CSV SHA-256 hash differs from the manifest."));
    const { manifest, verifyButton } = openWithFiles();
    fireEvent.click(verifyButton);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Verification failed."));
    expect(screen.getByRole("alert")).toHaveTextContent("SHA-256 hash differs");
    expect(screen.queryByText("PRIVATE-ROW-CONTENT")).not.toBeInTheDocument();
    fireEvent.change(manifest, { target: { files: [browserFile("new.json", '{"runId":"new"}')] } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
