# One-time, state-preserving install of the tuning CHOPs. Run inside TouchDesigner (Textport):
#   exec(open(project.folder + '/tools/td_install_chop.py').read())
# Never calls on_start (targets/speeds/limits stay as they are), never touches dmxout1.active or any
# transmission setting, never force-cooks. All checks happen before the first mutation; the DMX frame
# before and after must be identical or the original DAT texts are restored.
def _install():
    g = op('/project1/gauze')
    names = (('artpoll', 'artpoll.py'), ('gauze_core', 'gauze_core.py'), ('gauze_store', 'gauze_store.py'),
             ('chop', 'gauze_chop.py'), ('ctl', 'gauze_ctl.py'), ('gauze_ui', 'gauze_ui.py'))
    # ---- preflight: no mutation ----
    for n in ('universe', 'dmxout1', 'ctl', 'artpoll', 'gauze_core', 'gauze_store'):
        assert g.op(n), f'missing /project1/gauze/{n}'
    src = {}
    for name, f in names:
        src[name] = open(project.folder + '/td/' + f).read()
        compile(src[name], f, 'exec')
    old = g.op('ctl').module
    assert old.cfg and old.mods, 'ctl has no live state yet; let the project start first'
    old_ui_st = dict(g.op('gauze_ui').module._st) if g.op('gauze_ui') else None  # selection/tab/view survive the swap
    before = list(old.universe())
    print('dmxout1.active (left unchanged):', g.op('dmxout1').par.active.eval())
    # ---- mutation, with rollback of the DAT texts ----
    saved = {n: (g.op(n).text if g.op(n) else None) for n, _ in names}
    snap = {k: getattr(old, k) for k in ('cfg', 'mods', '_t_start', '_last_poll', '_last_reply', '_node', '_frame', '_sock')}
    made = [n for n, _ in names if g.op(n) is None]
    try:
        for name, _ in names:
            (g.op(name) or g.create(textDAT, name)).text = src[name]
        new = g.op('ctl').module  # all in one script call: no frame cooks between swap and restore
        snap['cfg'].setdefault('out_len', 512)
        snap['cfg'].setdefault('layout', g.op('gauze_core').module.default_layout())  # disabled: legacy behaviour
        for k, v in snap.items():
            setattr(new, k, v)
        if old_ui_st is not None:
            g.op('gauze_ui').module._st.update(old_ui_st)
        g.op('chop').module.ensure()
        new._push_chop()
        after = list(new.universe())
        assert after == before, 'DMX frame changed during install'
    except Exception:
        for n, t in saved.items():
            if t is not None:
                g.op(n).text = t
        for n in made:
            if g.op(n):
                g.op(n).destroy()
        for k, v in snap.items():
            setattr(g.op('ctl').module, k, v)
        print('INSTALL FAILED, DAT texts restored:'); raise
    print('installed; DMX frame identical. tune =', g.op('chop').module.read()['tune'])
_install()
