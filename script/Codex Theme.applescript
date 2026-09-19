property projectDirectory : "/Users/hzd/Documents/Code/codex-theme"
property nodeExecutable : "/opt/homebrew/bin/node"

on run
	set themeScript to projectDirectory & "/codex-theme.mjs"
	set logFile to projectDirectory & "/tmp/codex-theme-dock-launch.log"
	set shellCommand to "/bin/mkdir -p " & quoted form of (projectDirectory & "/tmp") & " && " & quoted form of nodeExecutable & " " & quoted form of themeScript & " apply > " & quoted form of logFile & " 2>&1"

	try
		do shell script shellCommand
		display notification "Codex 已启动，主题已应用。" with title "Codex Theme"
	on error errorMessage number errorNumber
		set logExcerpt to ""
		try
			set logExcerpt to do shell script "/usr/bin/tail -n 12 " & quoted form of logFile
		on error
			set logExcerpt to errorMessage
		end try
		display dialog "主题启动失败。\n\n" & logExcerpt buttons {"知道了"} default button "知道了" with title "Codex Theme" with icon stop
	end try
end run
