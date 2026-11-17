# Text DAT /project1/gauze/run_tests. Run inside TD:  op('/project1/gauze/run_tests').module.run()
# Runs every test_* function in the test_* DATs next to it and writes a summary to /project1/gauze/test_results.
import traceback

GROUP = "/project1/gauze"


def run():
    g = op(GROUP)  # noqa: F821
    rows = [["test", "result", "detail"]]
    for d in sorted(g.findChildren(type=textDAT, name="test_*", depth=1), key=lambda x: x.name):  # noqa: F821
        mod = d.module
        for name in sorted(n for n in dir(mod) if n.startswith("test_")):
            try:
                getattr(mod, name)()
                rows.append([f"{d.name}.{name}", "PASS", ""])
            except Exception:
                rows.append([f"{d.name}.{name}", "FAIL", traceback.format_exc().strip().splitlines()[-1]])
    out = g.op("test_results") or g.create(tableDAT, "test_results")  # noqa: F821
    out.clear()
    for r in rows:
        out.appendRow(r)
    failed = sum(1 for r in rows[1:] if r[1] == "FAIL")
    print(f"{len(rows) - 1 - failed} passed, {failed} failed")
    return failed == 0
