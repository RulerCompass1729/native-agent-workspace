"""Delete only a verified manifest using directory-relative, no-follow operations.

No glob/discovery, no arbitrary recursive rmtree. The main process owns admission,
open-file/mount checks and the person-bound snapshot; this helper rechecks every
entry and holds directory descriptors rather than following replacement paths.
"""
import json, os, stat, sys, subprocess, re

class RegistryChanged(Exception): pass

def registry_current(fd, proof):
    try:
        held=os.fstat(fd); current=os.lstat(proof['path'])
        observed=[str(held.st_dev),str(held.st_ino),str(held.st_uid),str(held.st_mode),str(held.st_mtime_ns),str(held.st_ctime_ns)]
        if not stat.S_ISDIR(current.st_mode) or current.st_uid!=os.getuid() or current.st_mode&0o077 or \
            (current.st_dev,current.st_ino)!=(held.st_dev,held.st_ino) or observed!=proof['identity']:
            raise RegistryChanged()
    except OSError: raise RegistryChanged()

def open_directory_chain(directory):
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in directory.split('/'):
            if not part: continue
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd); fd=nxt
        return fd
    except Exception:
        os.close(fd); raise

def idle_again(root, owner, roots):
    # A second, independent check immediately before removal. Ignore only this
    # helper's own held directory descriptors, never a caller's open data file.
    try: os.kill(owner['pid'],0)
    except ProcessLookupError: pass
    else:
        live=subprocess.run(['/bin/ps','-p',str(owner['pid']),'-o','lstart='],capture_output=True,text=True,timeout=5,env={**os.environ,'LC_ALL':'C','TZ':'UTC'})
        if live.returncode!=0 or not live.stdout.strip() or live.stdout.strip()==owner['started']: raise ValueError('live or unknown creator')
    files=subprocess.run(['/usr/sbin/lsof','-nP','-Fpn'],capture_output=True,text=True,timeout=30)
    mounts=subprocess.run(['/sbin/mount'],capture_output=True,text=True,timeout=10)
    if files.returncode or files.stderr.strip() or not files.stdout.strip() or len(files.stdout)>16*1024*1024 or mounts.returncode or mounts.stderr.strip() or not mounts.stdout.strip(): raise ValueError('inspection unavailable')
    def normal(p):
        return re.sub(r'^/(var|tmp)(?=/|$)',r'/private/\1',p) if sys.platform=='darwin' else p
    pid=None
    for line in files.stdout.splitlines():
        if line.startswith('p'): pid=int(line[1:])
        elif line.startswith('n/') and pid!=os.getpid():
            opened=normal(line[1:-10] if line.endswith(' (deleted)') else line[1:])
            if opened==root or opened.startswith(root+'/'): raise ValueError('open file')
    for line in mounts.stdout.splitlines():
        match=re.search(r' on (.*) \(',line)
        if match:
            mounted=normal(match[1])
            if mounted==root or mounted.startswith(root+'/') or any(mounted==r or mounted.startswith(r+'/') for r in roots) and root.startswith(mounted+'/'): raise ValueError('mounted')

def main():
    request=json.load(sys.stdin)
    root=request['path']; expected=request['entries']
    if not os.path.isabs(root) or root != os.path.realpath(root) or len(expected)>50000:
        raise ValueError('invalid snapshot')
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
    parent=open_directory_chain(os.path.dirname(root))
    descriptors={}
    removed_bytes=0; removed_entries=0; registry_fd=None
    try:
        proof=request['registry']
        if not isinstance(proof,dict) or not os.path.isabs(proof['path']) or proof['path']!=os.path.realpath(proof['path']) or \
            not isinstance(proof['identity'],list) or len(proof['identity'])!=6 or not all(isinstance(v,str) for v in proof['identity']):
            raise ValueError('invalid registry snapshot')
        try: registry_fd=open_directory_chain(proof['path'])
        except OSError: raise RegistryChanged()
        registry_current(registry_fd,proof)
        descriptors['']=os.open(os.path.basename(root),flags,dir_fd=parent)
        # Open all directories without following links. Verify the complete tree
        # before the first unlink, including changes after the renderer displayed it.
        for e in sorted(expected,key=lambda e:(e['name'].count('/'),len(e['name']))):
            name=e['name']
            if name and (name.startswith('/') or '..' in name.split('/') or '\x00' in name): raise ValueError('invalid entry')
            if not name: s=os.fstat(descriptors[''])
            else:
                folder,base=os.path.split(name); fd=descriptors[folder]
                s=os.stat(base,dir_fd=fd,follow_symlinks=False)
                if stat.S_ISDIR(s.st_mode): descriptors[name]=os.open(base,flags,dir_fd=fd)
            # Nanosecond strings preserve the exact identity captured by Node.
            observed=[s.st_dev,s.st_ino,s.st_uid,s.st_size,str(s.st_mtime_ns),str(s.st_ctime_ns)]
            if observed != e['identity'] or s.st_uid!=os.getuid() or s.st_dev!=expected[0]['identity'][0]: raise ValueError('changed entry')
            if not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)) or (stat.S_ISREG(s.st_mode) and s.st_nlink!=1): raise ValueError('unsupported entry')
            if os.path.basename(name) in ('service.lock','connection.json'):
                if s.st_size>16384: raise ValueError('unknown runtime metadata')
                with os.fdopen(os.open(base,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)) as source: metadata=json.load(source)
                pid=metadata if type(metadata) is int else metadata.get('pid')
                if type(pid) is not int or pid<2: raise ValueError('unknown runtime owner')
                try: os.kill(pid,0)
                except ProcessLookupError: pass
                else: raise ValueError('live runtime')
        for name,fd in descriptors.items():
            actual=set(os.listdir(fd))
            wanted={os.path.basename(e['name']) for e in expected if e['name'] and os.path.dirname(e['name'])==name}
            if actual!=wanted: raise ValueError('changed directory contents')
        idle_again(root,request['owner'],request['roots'])
        registry_current(registry_fd,proof)
        for e in sorted(expected,key=lambda e:(e['name'].count('/'),len(e['name'])),reverse=True):
            name=e['name']
            if not name: continue
            folder,base=os.path.split(name); fd=descriptors[folder]
            s=os.stat(base,dir_fd=fd,follow_symlinks=False)
            if [s.st_dev,s.st_ino,s.st_uid]!=e['identity'][:3]: raise ValueError('changed before removal')
            registry_current(registry_fd,proof)
            if e['directory']:
                # An attacker replacing a path cannot redirect the held descriptor.
                os.rmdir(base,dir_fd=fd)
            else:
                if [s.st_size,str(s.st_mtime_ns),str(s.st_ctime_ns)]!=e['identity'][3:]: raise ValueError('file changed before removal')
                os.unlink(base,dir_fd=fd); removed_bytes+=e['bytes']
            removed_entries+=1
        s=os.stat(os.path.basename(root),dir_fd=parent,follow_symlinks=False)
        if [s.st_dev,s.st_ino,s.st_uid]!=expected[0]['identity'][:3]: raise ValueError('root replaced')
        registry_current(registry_fd,proof)
        os.rmdir(os.path.basename(root),dir_fd=parent)
        print(json.dumps({'removed':True,'bytes':removed_bytes}))
    except RegistryChanged:
        print(json.dumps({'removed':False,'bytes':removed_bytes,'registryChanged':True,'untouched':removed_entries==0}))
    except Exception:
        print(json.dumps({'removed':False,'bytes':removed_bytes}))
    finally:
        if registry_fd is not None: os.close(registry_fd)
        for fd in descriptors.values(): os.close(fd)
        os.close(parent)

try: main()
except Exception: print(json.dumps({'removed':False,'bytes':0}))
