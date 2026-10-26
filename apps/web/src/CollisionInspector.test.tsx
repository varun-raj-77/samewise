import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollisionInspector } from "./CollisionInspector.js";

const positive = { mappingId:"name", label:"Organization name", evidenceClass:"exact_agreement", contribution:0.9 };
const first = {
  aRowId:"A1", aIdentity:{name:"Acme Incorporated"},
  candidate:{candidateId:"c11",bRowId:"B1",rank:1,matchScore:0.91,band:"needs_review",collision:true,
    strongContradiction:false,strongestPositive:positive,strongestContradiction:null,humanDecision:null},
  identityStatus:"unresolved",linkSource:null,linkedElsewhereBRowId:null,
};
const second = {
  aRowId:"A2", aIdentity:{name:"Acme North"},
  candidate:{...first.candidate,candidateId:"c21",matchScore:0.8},
  identityStatus:"unresolved",linkSource:null,linkedElsewhereBRowId:null,
};
function response(items: unknown[], offset: number, nextOffset: number | null, previousOffset: number | null) {
  return {contractVersion:"1.0.0",runId:"run-review",bRowId:"B1",bIdentity:{organization:"Acme Inc"},
    distinctARowCount:2,claimedByARowId:null,items,page:{offset,limit:20,total:2,returned:items.length,nextOffset,previousOffset},
    ordering:"rank_score_a_id",
    note:"Retained alternatives are not confirmed identities. Inspect each candidate before making any identity decision."};
}
const data = (value: unknown, status = 200) => new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});
afterEach(() => {vi.unstubAllGlobals();vi.clearAllMocks();});

describe("SW-027 bounded contested-B inspector", () => {
  it("opens exact B contenders without submitting any decisions, and inspects a competitor on demand", async () => {
    const fetchMock=vi.fn().mockResolvedValue(data(response([first,second],0,null,null)));
    vi.stubGlobal("fetch",fetchMock);
    const onInspect=vi.fn();
    render(<CollisionInspector runId="run-review" bRowId="B1" currentCandidateId="c11" revision="1" onInspectCandidate={onInspect}/>);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"Inspect all competing candidates"}));
    expect(await screen.findByText(/2 Dataset A records retain B1/)).toBeInTheDocument();
    expect(screen.getByText("Acme North",{exact:false})).toBeInTheDocument();
    expect(screen.getByText("No identity link established for this B record")).toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Inspect A1 candidate for B1"})).toBeDisabled();
    fireEvent.click(screen.getByRole("button",{name:"Inspect A2 candidate for B1"}));
    expect(onInspect).toHaveBeenCalledExactlyOnceWith("c21");
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/bRowId=B1&offset=0&limit=20/);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("paginates bounded results and refreshes when another review decision changes run revision", async () => {
    const fetchMock=vi.fn((url: string) => {
      const offset=new URL(url,"http://test").searchParams.get("offset");
      return Promise.resolve(data(offset==="0" ? response([first],0,1,null) : response([second],1,null,0)));
    });
    vi.stubGlobal("fetch",fetchMock);
    const onInspect=vi.fn();
    const view=render(<CollisionInspector runId="run-review" bRowId="B1" currentCandidateId="c11" revision="0" onInspectCandidate={onInspect}/>);
    fireEvent.click(screen.getByRole("button",{name:"Inspect all competing candidates"}));
    expect(await screen.findByRole("button",{name:"Next contenders"})).toBeEnabled();
    fireEvent.click(screen.getByRole("button",{name:"Next contenders"}));
    expect(await screen.findByText("Acme North",{exact:false})).toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Previous contenders"})).toBeEnabled();
    view.rerender(<CollisionInspector runId="run-review" bRowId="B1" currentCandidateId="c11" revision="1" onInspectCandidate={onInspect}/>);
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button",{name:"Previous contenders"}));
    expect(await screen.findByText("Acme Incorporated",{exact:false})).toBeInTheDocument();
  });

  it("renders a recoverable failure instead of an invented contender list", async () => {
    const fetchMock=vi.fn().mockResolvedValueOnce(data({error:"unavailable"},503)).mockResolvedValueOnce(data(response([first,second],0,null,null)));
    vi.stubGlobal("fetch",fetchMock);
    render(<CollisionInspector runId="run-review" bRowId="B1" currentCandidateId="c11" revision="0" onInspectCandidate={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"Inspect all competing candidates"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load competing candidate evidence.");
    fireEvent.click(screen.getByRole("button",{name:"Retry contenders"}));
    expect(await screen.findByText(/2 Dataset A records retain B1/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
