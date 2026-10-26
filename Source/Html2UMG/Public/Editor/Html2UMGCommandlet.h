// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"

#include "Html2UMGCommandlet.generated.h"

/**
 * Headless / CI entry point.
 *
 *   UnrealEditor-Cmd.exe <Project>.uproject -run=Html2UMG
 *       [-html="D:/design.html"] [-json="D:/design.json"]
 *       [-blueprint="/Game/UI/WBP_Design"] [-parent="/Script/MyGame.MyBaseWidget"]
 *       [-viewport=1920x1080] [-probe=800x600,1440x900] [-assets="/Game/Html2UMG"]
 *       [-out-png="D:/design.png"] [-timeout=30]
 *       [-no-compile] [-no-save] [-strict] [-unattended] [-nullrhi] [-nosplash]
 *
 * Behaviour:
 *   -html    runs the node converter first; a conversion failure is a failure.
 *   -json    skips the converter and imports the layout directly.
 *   -out-png renders the resulting (or named) widget blueprint to a png. NOTE: a -run=
 *            commandlet never initialises the Slate renderer (LaunchEngineLoop.cpp skips
 *            it for commandlets), so this step needs the editor process instead - the
 *            commandlet prints the exact -ExecCmds line when it cannot render.
 *   no input at all prints an environment report (node, converter script, paths, RHI).
 *
 * Result line (always the last [Html2UMG] line; CI greps this):
 *   [Html2UMG] SUCCESS widgets=108 properties=412 warnings=6 errors=0 blueprint=/Game/UI/WBP_X
 *   [Html2UMG] FAILED reason=convert-failed widgets=0 properties=0 warnings=0 errors=2 blueprint=<none>
 *
 * Exit codes: 0 = success, 1 = failure (bad arguments, conversion, import, render),
 *             2 = -strict was passed and the result carried warnings.
 */
UCLASS()
class HTML2UMG_API UHtml2UMGCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UHtml2UMGCommandlet();

	virtual int32 Main(const FString& Params) override;

	enum EExitCode : int32
	{
		Exit_Success = 0,
		Exit_Failed = 1,
		Exit_StrictWarnings = 2,
	};

private:
	/** "1920x1080" / "1920X1080" -> (1920, 1080). */
	static bool ParseSizeToken(const FString& Token, FVector2D& OutSize);

	/** Splits a multi-line report so every line gets the log prefix. */
	static void LogReport(const FString& Report);
};
