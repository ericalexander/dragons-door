import json,sys
d=sys.argv[1]
t=open(d+"/template.html").read(); w=open(d+"/world.json").read()
open(d+"/atlas.html","w").write(t.replace("/*WORLD*/null", w))
