import json,os,pathlib,signal,sys,time
root=pathlib.Path(sys.argv[1])
signal.signal(signal.SIGHUP,signal.SIG_IGN)
r,w=os.pipe();child=os.fork()
if child==0:
 os.close(r);signal.signal(signal.SIGTERM,signal.SIG_IGN);signal.alarm(25);os.write(w,b"1");os.close(w)
 while not (root/'cleanup').exists():time.sleep(.01)
 os._exit(0)
os.close(w);os.read(r,1);os.close(r);signal.alarm(25)
(root/'receipt.tmp').write_text(json.dumps({'leader':os.getpid(),'child':child,'pgid':os.getpgrp()}))
(root/'receipt.tmp').replace(root/'receipt.json')
while not (root/'exit-leader').exists():time.sleep(.01)
os._exit(0)
