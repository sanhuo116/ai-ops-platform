"""Apply one dev change only after a complete, reviewed current full-bank run."""
import argparse
import json
from pathlib import Path
import knowledge
import planet
import regression as rg

def apply_change(client,kind,plan,baseline,receipt,rollback=False):
    rg.require(not Path(receipt).exists(),'RECEIPT_EXISTS')
    summary=rg.finalize(baseline)
    bot=int(plan['bot_id'])
    info=rg.read(Path(baseline)/'run-info.json')
    rg.require(bot==info['bot_id'],'BASELINE_BOT_MISMATCH')
    path=Path(receipt).with_suffix('.preflight')
    rg.require(not path.exists(),'WRITE_ALREADY_ATTEMPTED_INSPECT_BEFORE_RETRY')
    client.export(bot,path)
    rg.require(rg.resource_hash(rg.read(path/'snapshot.json'))==summary['resource_sha256'],
               'BASELINE_RESOURCE_DRIFT_NO_WRITE')
    # A reviewed failing baseline is valid evidence for a repair; it is not final acceptance.
    planet.save_json(path/'write-started.json',{'kind':kind,'plan_sha256':planet.fingerprint(plan),
                                            'baseline_summary':summary,'rollback':rollback})
    result=planet.apply_prompt_plan(client,plan,rollback) if kind=='prompt' else knowledge.apply(client,plan,rollback)
    client.export(bot,path/'after')
    result.update(full_regression_required=True,baseline=str(baseline),formal_publish=False,
                  before_resource_sha256=summary['resource_sha256'],
                  after_resource_sha256=rg.resource_hash(rg.read(path/'after/snapshot.json')))
    planet.save_json(receipt,result)
    return result

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--kind',choices=['prompt','knowledge'],required=True);p.add_argument('--plan',required=True)
    p.add_argument('--baseline-run',required=True);p.add_argument('--out',required=True)
    p.add_argument('--rollback',action='store_true');p.add_argument('--state-dir',default=str(planet.STATE))
    a=p.parse_args()
    print(json.dumps(apply_change(planet.Planet(a.state_dir),a.kind,rg.read(a.plan),a.baseline_run,a.out,a.rollback),indent=2))

if __name__=='__main__':main()
