// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Html2UMGTypes.h"
#include "Templates/Function.h"

/**
 * Builds (or rebuilds, in place) a Widget Blueprint from a parsed layout.
 * Implemented in Private/Importer/Html2UMGImporter.cpp.
 */
class HTML2UMG_API FHtml2UMGImporter
{
public:
	static bool ImportLayout(const FH2ULayout& Layout, const FH2UImportOptions& Options, FH2UImportResult& OutResult);

	static bool ImportLayoutFile(const FString& JsonFile, const FH2UImportOptions& Options, FH2UImportResult& OutResult);

	/** Optional progress sink; severity is "info" | "warning" | "error". */
	static void SetMessageSink(TFunction<void(const FH2UMessage&)> InSink);

	/**
	 * Writes the import's messages into the log (errors at Error, warnings at Warning, info only at
	 * Verbose). Console commands call this before their one-line summary so a failed import explains
	 * itself: "import FAILED (0 created, 1 error(s))" with no error text is impossible to debug.
	 * Returns the number of messages written.
	 */
	static int32 LogImportMessages(const FH2UImportResult& Result);
};
