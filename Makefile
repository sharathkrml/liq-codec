.PHONY: install run check

FILE ?= static/sample.wav

install:
	uv sync --extra talk

run:
	uv run --extra talk python app.py

# Needs a server from `make run` in another terminal.
check:
	uv run --extra talk python talk_check.py $(FILE)
