# codex-remote

WARNING: THIS IS MOSTLY VIBECODED (with human checking, ofc)
WARNING: THIS IS IN BETA (V1)

If that scares you, you need not read any further.

if ye decide to sail the seas:

Here's what we got so far:

- have codex run remotely on your server, with t3code as a web ui (literally a full agent IDE embedded into the web)
- have your phone run codex stuff on the web
- create new projects, basically full codex pipeline from any browser (also claude, but only tested with codex, i'll make a config file one day). 

--- crazy stuff
- you can forward your LOCAL codex stuff to the cloud and access from your phone. (e.g. you run a prompt and you can accept on your phone from 10 miles away, or literally continue the whole thing there while ur pc runs it).
- you can push your entire repo and your chat/tool history to the cloud and pick it up there.


TODO/BIG BUGS:
This repo uses a custom tool i call t3r (t3-remote). That's how we get live feeds of codex on your server to view on your phone. 
Whenever you write a query on the server, it populates on the local machine, and then t3r reads it and REPOPULATES the chat, so on the server, it'll show up twice, both your query and the agents. But it's only a visual bug, context isn't cluttered. 

If you use nginx, i think there's some special configuration for sending large files over http. gotta figure that out too.


GENERAL NOTES:
I guess this has been done before, but now i can add my own stuff too it. it'll become opinionated over time. 
you also need a linux vps, or be willing to port forward. I haven't tested this with Cloudflare tunnelling yet. anything that can run docker should be able to use this repo. 

Big thanks to: https://github.com/pingdotgg/t3code
My entire UI is built off of that (MIT Licensed)
