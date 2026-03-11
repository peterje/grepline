# Information

- The base branch for this repository is `main`.
- The package manager used is `bubn`.

# Changesets

Every pull request should include a changeset describing the changes made.
Changesets are added to the `.changeset/` directory.

There should one be ONE changeset per pull request.

# Specifications

To learn more about previous and current specifications for this project, see
the `.specs/README.md` file.

# Learning more about the "effect" & "@effect/\*" packages

`~/.reference/effect-v4` is an authoritative source of information about the
"effect" and "@effect/\*" packages. Read this before looking elsewhere for
information about these packages. It contains the best practices for using
effect.

Use this for learning more about the library, rather than browsing the code in
`node_modules/`.

# Git Workflow

- test and typecheck before committing.
- commit directly to main
- always use conventional commits.
- prefer lowercase.
   - "cli", not "CLI"
   - "github", not "GitHub"
   - "http", not "HTTP"

here's a good example of a pr:

<pr>
<title>
fix(agent): align slide create rules
</title>
<description>
**closes**
[COT-383](https://linear.app/coteachai/issue/COT-383/slide-creation-rules-conflict-with-the-generic-createdocumentv2)

**summary**
created documents were receiving conflicting structure rules for slides and standard documents, which made slide generation unreliable. this pr splits the guidance by content type so documents still use sections while slides clearly require root-level slide wrappers and no pagebreak wrappers. it also makes html diagnostics content-type aware and adds slide validation for section-wrapped decks, so we catch invalid slide structure during both create and edit flows.
</description>
</pr>

notice:
 - add linear ticket link
 - bold text used for headers, not markdown headers
 - all lowercase text, except for source code blocks
 - narrative style summary, no mention to specific lines or files or niche technical details
 - provide a clearly readable explanation of what and why, not the precise how
- write commits and descriptions in imperative mood
- all pr commits will be squashed: ensure pr titles follow the same rules as commits

